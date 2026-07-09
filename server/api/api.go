// Package api wires the HTTP and WebSocket endpoints to the store, auth, hub,
// and garden packages. It is the seam between "browser requests" and "app
// logic": handlers here validate input, call into the other packages, and
// shape the JSON responses.
package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"image/gif"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"hearth/auth"
	"hearth/garden"
	"hearth/hub"
	"hearth/store"
)

// Server holds the dependencies every handler needs.
type Server struct {
	st        *store.Store
	hub       *hub.Hub
	uploadDir string // absolute path to <data>/uploads
	weather   *weatherService
}

// New creates the API server and the realtime hub. The hub's inbound handler is
// wired to onWSMessage so a frame from the browser becomes a stored, broadcast
// chat message. lat/lon may be empty, which simply disables local weather;
// place overrides the auto-detected location label.
func New(st *store.Store, uploadDir, lat, lon, place string) *Server {
	s := &Server{st: st, uploadDir: uploadDir, weather: newWeatherService(lat, lon, place)}
	s.hub = hub.New(s.onWSMessage)
	return s
}

// Mount registers all API, WebSocket, and upload routes on the given mux.
// Protected routes are wrapped so they require a valid session.
func (s *Server) Mount(mux *http.ServeMux) {
	// Auth endpoints are public (you can't be logged in to log in). The setup
	// pair is public too, but only does anything while no accounts exist yet.
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	mux.HandleFunc("GET /api/setup-status", s.handleSetupStatus)
	mux.HandleFunc("POST /api/setup", s.handleSetup)

	// Everything below requires a session.
	mux.Handle("GET /api/me", s.protect(s.handleMe))
	mux.Handle("GET /api/messages", s.protect(s.handleMessages))
	mux.Handle("POST /api/read", s.protect(s.handleMarkRead))
	mux.Handle("POST /api/profile", s.protect(s.handleProfile))
	mux.Handle("POST /api/nickname", s.protect(s.handleNickname))
	mux.Handle("POST /api/upload/avatar", s.protect(s.handleUploadAvatar))
	mux.Handle("POST /api/upload/notif-sound", s.protect(s.handleUploadNotifSound))
	mux.Handle("GET /api/notif-sounds", s.protect(s.handleListNotifSounds))
	mux.Handle("POST /api/notif-sound/delete", s.protect(s.handleDeleteNotifSound))
	mux.Handle("POST /api/upload/chat-bg", s.protect(s.handleUploadChatBG))
	mux.Handle("POST /api/upload/message-image", s.protect(s.handleUploadMessageImage))
	mux.Handle("GET /api/stickers", s.protect(s.handleListStickers))
	mux.Handle("POST /api/upload/sticker", s.protect(s.handleUploadSticker))
	mux.Handle("POST /api/sticker/rename", s.protect(s.handleRenameSticker))
	mux.Handle("POST /api/sticker/delete", s.protect(s.handleDeleteSticker))
	mux.Handle("GET /api/garden", s.protect(s.handleGarden))
	mux.Handle("GET /api/weather", s.protect(s.handleWeather))
	mux.Handle("POST /api/garden/water", s.protect(s.handleWater))
	mux.Handle("GET /api/game/score", s.protect(s.handleGameScore))
	mux.Handle("POST /api/game/score", s.protect(s.handleSubmitGameScore))
	mux.Handle("GET /ws", s.protect(s.handleWS))

	// Uploaded files (avatars, backgrounds, sounds, sent images) are also behind
	// the session so nothing in the data folder is served to a stranger.
	fs := http.StripPrefix("/uploads/", http.FileServer(http.Dir(s.uploadDir)))
	mux.Handle("GET /uploads/", auth.Middleware(s.st, fs))
}

// protect wraps a handler func with the auth middleware.
func (s *Server) protect(h http.HandlerFunc) http.Handler {
	return auth.Middleware(s.st, h)
}

// --- Auth handlers ---------------------------------------------------------

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	u, err := auth.Login(w, r, s.st, strings.TrimSpace(req.Username), req.Password)
	if err != nil {
		httpError(w, http.StatusUnauthorized, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, s.publicUser(u))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	auth.Logout(w, r, s.st)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// --- First-open setup --------------------------------------------------------

// handleSetupStatus tells the frontend whether the two accounts still need to
// be created (fresh install with no env-configured accounts).
func (s *Server) handleSetupStatus(w http.ResponseWriter, r *http.Request) {
	n, err := s.st.UserCount()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot check setup state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"needsSetup": n == 0})
}

// handleSetup creates both accounts from the first-open screen and logs the
// person at the keyboard (the host) in as the first one. It refuses to run
// once any account exists, so it cannot be used to reset or hijack anything.
func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	n, err := s.st.UserCount()
	if err != nil || n > 0 {
		httpError(w, http.StatusForbidden, "setup was already completed")
		return
	}
	var req struct {
		Username1 string `json:"username1"`
		Password1 string `json:"password1"`
		Username2 string `json:"username2"`
		Password2 string `json:"password2"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	u1 := strings.TrimSpace(req.Username1)
	u2 := strings.TrimSpace(req.Username2)
	switch {
	case u1 == "" || u2 == "":
		httpError(w, http.StatusBadRequest, "both usernames are needed")
		return
	case u1 == u2:
		httpError(w, http.StatusBadRequest, "the two usernames must be different")
		return
	case len(req.Password1) < 4 || len(req.Password2) < 4:
		httpError(w, http.StatusBadRequest, "passwords need at least 4 characters")
		return
	}

	// Display names start as the usernames; both are changeable in Settings.
	for _, acc := range []struct{ user, pass string }{{u1, req.Password1}, {u2, req.Password2}} {
		hash, err := auth.HashPassword(acc.pass)
		if err != nil {
			httpError(w, http.StatusInternalServerError, "could not secure password")
			return
		}
		if _, err := s.st.CreateUser(acc.user, hash, acc.user); err != nil {
			httpError(w, http.StatusInternalServerError, "could not create account")
			return
		}
	}

	// The host who filled the form is account 1 — welcome them straight in.
	user, err := auth.Login(w, r, s.st, u1, req.Password1)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "accounts created but login failed")
		return
	}
	writeJSON(w, http.StatusOK, s.publicUser(user))
}

// --- Profile / identity ----------------------------------------------------

// publicUser is the JSON shape of a user we expose to the frontend (no hash).
type publicUser struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarPath  string `json:"avatarPath"`
	NotifSound  string `json:"notifSound"`
	ChatBG      string `json:"chatBg"`
}

func (s *Server) publicUser(u *store.User) publicUser {
	return publicUser{
		ID: u.ID, Username: u.Username, DisplayName: u.DisplayName,
		AvatarPath: u.AvatarPath, NotifSound: u.NotifSound, ChatBG: u.ChatBGPath,
	}
}

// partnerOf returns the other account (the app always has exactly two users).
func (s *Server) partnerOf(me *store.User) (*store.User, error) {
	users, err := s.st.AllUsers()
	if err != nil {
		return nil, err
	}
	for _, u := range users {
		if u.ID != me.ID {
			return u, nil
		}
	}
	return nil, nil // should not happen once both accounts are seeded
}

// handleMe returns who I am, who my partner is, and the private nickname I use
// for them.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	partner, err := s.partnerOf(me)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load partner")
		return
	}
	readID, _ := s.st.LastReadID(me.ID)
	resp := map[string]any{"user": s.publicUser(me), "readId": readID}
	if partner != nil {
		resp["partner"] = s.publicUser(partner)
		nick, _ := s.st.Nickname(me.ID, partner.ID)
		resp["partnerNickname"] = nick
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleMarkRead advances how far I've read the conversation. The client calls
// this while I'm actually looking at the chat, so unread markers reflect what
// I've genuinely seen.
func (s *Server) handleMarkRead(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	var req struct {
		ID int64 `json:"id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.st.SetLastReadID(me.ID, req.ID); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save read state")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleProfile updates my own display name.
func (s *Server) handleProfile(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	var req struct {
		DisplayName string `json:"displayName"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" {
		httpError(w, http.StatusBadRequest, "display name cannot be empty")
		return
	}
	if err := s.st.SetDisplayName(me.ID, name); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save name")
		return
	}
	me.DisplayName = name
	s.broadcastProfile(me) // let my partner's screen update without a reload
	writeJSON(w, http.StatusOK, map[string]string{"displayName": name})
}

// handleNickname sets the private nickname I use for my partner.
func (s *Server) handleNickname(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	partner, err := s.partnerOf(me)
	if err != nil || partner == nil {
		httpError(w, http.StatusInternalServerError, "no partner to nickname")
		return
	}
	var req struct {
		Nickname string `json:"nickname"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	nick := strings.TrimSpace(req.Nickname)
	if err := s.st.SetNickname(me.ID, partner.ID, nick); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save nickname")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"nickname": nick})
}

// --- Messages --------------------------------------------------------------

// handleMessages returns a page of history, oldest-first for easy rendering.
func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	msgs, err := s.st.RecentMessages(before, limit)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load messages")
		return
	}
	// RecentMessages returns newest-first; reverse so the client can append.
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

// wsMessageIn is the frame a client sends to post a chat message.
type wsMessageIn struct {
	Type      string `json:"type"`
	Body      string `json:"body"`
	ImagePath string `json:"imagePath"`
}

// wsMessageOut wraps a stored message for broadcast.
type wsMessageOut struct {
	Type    string         `json:"type"`
	Message *store.Message `json:"message"`
}

// onWSMessage is invoked by the hub for each inbound frame. It persists the
// message, broadcasts it to both clients, and nudges the garden.
func (s *Server) onWSMessage(userID int64, data []byte) {
	var in wsMessageIn
	if err := json.Unmarshal(data, &in); err != nil {
		return
	}
	if in.Type != "message" {
		return
	}
	body := strings.TrimSpace(in.Body)
	if body == "" && in.ImagePath == "" {
		return // nothing to send
	}
	// Only accept image paths we actually served, so a client can't point a
	// message at an arbitrary file on disk.
	if in.ImagePath != "" && !strings.HasPrefix(in.ImagePath, "/uploads/") {
		return
	}

	msg, err := s.st.AddMessage(userID, body, in.ImagePath)
	if err != nil {
		log.Printf("failed to store message: %v", err)
		return
	}
	s.hub.Broadcast(wsMessageOut{Type: "message", Message: msg})

	// Talking makes the garden grow; broadcast the garden only if the change is
	// visible (new stage, flower, or streak day).
	changed, err := garden.OnMessage(s.st)
	if err != nil {
		log.Printf("garden update failed: %v", err)
		return
	}
	if changed {
		s.broadcastGarden()
	}
}

// handleWS upgrades an authenticated request to a WebSocket connection.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	s.hub.ServeWS(w, r, me.ID)
}

// --- Garden ----------------------------------------------------------------

func (s *Server) handleGarden(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	v, err := garden.ViewFor(s.st, me.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load garden")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleWater(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	v, changed, err := garden.Water(s.st, me.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to water")
		return
	}
	if changed {
		s.broadcastGarden()
	}
	writeJSON(w, http.StatusOK, v)
}

// --- Game high score -------------------------------------------------------

// gameHigh is the JSON shape for the shared best score: the score plus who set
// it (so both of us see one leaderboard), and the most recent plays.
type gameHigh struct {
	Score       int              `json:"score"`
	HolderID    int64            `json:"holderId"`
	HolderName  string           `json:"holderName"`
	IsNewRecord bool             `json:"isNewRecord,omitempty"`
	Plays       []store.GamePlay `json:"plays"`
}

// loadGameHigh reads the current best (with the holder's display name) plus the
// five most recent plays.
func (s *Server) loadGameHigh() (gameHigh, error) {
	score, holderID, err := s.st.GameHigh()
	if err != nil {
		return gameHigh{}, err
	}
	g := gameHigh{Score: score, HolderID: holderID}
	if holderID > 0 {
		if u, err := s.st.UserByID(holderID); err == nil {
			g.HolderName = u.DisplayName
		}
	}
	plays, err := s.st.RecentGamePlays(5)
	if err != nil {
		return gameHigh{}, err
	}
	if plays == nil {
		plays = []store.GamePlay{}
	}
	g.Plays = plays
	return g, nil
}

func (s *Server) handleGameScore(w http.ResponseWriter, r *http.Request) {
	g, err := s.loadGameHigh()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load high score")
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// handleSubmitGameScore records a finished game's score, updating the shared
// best if it was beaten, and returns the (possibly new) leaderboard.
func (s *Server) handleSubmitGameScore(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	var req struct {
		Score int `json:"score"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if req.Score < 0 {
		httpError(w, http.StatusBadRequest, "invalid score")
		return
	}
	// Log the play (skip empty runs) so the recent-plays feed shows real games.
	if req.Score > 0 {
		if err := s.st.RecordGamePlay(me.ID, req.Score); err != nil {
			log.Printf("failed to record game play: %v", err)
		}
	}
	isNew, err := s.st.SubmitGameScore(me.ID, req.Score)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save score")
		return
	}
	g, err := s.loadGameHigh()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load high score")
		return
	}
	g.IsNewRecord = isNew
	writeJSON(w, http.StatusOK, g)
}

// broadcastProfile tells both clients that a user's public profile (name or
// photo) changed, so the partner's screen updates without needing a reload.
func (s *Server) broadcastProfile(u *store.User) {
	s.hub.Broadcast(map[string]any{"type": "profile", "user": s.publicUser(u)})
}

// broadcastGarden pushes the shared garden state to both clients.
func (s *Server) broadcastGarden() {
	shared, err := garden.SharedView(s.st)
	if err != nil {
		log.Printf("garden broadcast failed: %v", err)
		return
	}
	s.hub.Broadcast(shared)
}

// --- Uploads ---------------------------------------------------------------

// Accepted file extensions per upload kind, and per-kind size caps.
var (
	imageExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}
	audioExts = map[string]bool{".mp3": true, ".wav": true, ".ogg": true, ".m4a": true}
)

const (
	maxImageBytes = 10 << 20 // 10 MiB
	maxAudioBytes = 5 << 20  // 5 MiB
)

// saveUpload stores an upload in the top-level upload directory. See
// saveUploadTo for the details.
func (s *Server) saveUpload(w http.ResponseWriter, r *http.Request, allowed map[string]bool, maxBytes int64) (string, bool) {
	return s.saveUploadTo(w, r, allowed, maxBytes, "")
}

// saveUploadTo reads the "file" field of a multipart form, validates its
// extension against allowed, enforces maxBytes, and writes it under a random
// name inside <uploads>/<subdir> (subdir "" means the uploads root). It returns
// the public "/uploads/..." path. The multipart form stays parsed on r, so a
// caller can still read sibling fields (e.g. a sticker name) afterwards.
func (s *Server) saveUploadTo(w http.ResponseWriter, r *http.Request, allowed map[string]bool, maxBytes int64, subdir string) (string, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+1024) // headroom for form overhead
	if err := r.ParseMultipartForm(maxBytes + 1024); err != nil {
		httpError(w, http.StatusBadRequest, "file too large or malformed")
		return "", false
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpError(w, http.StatusBadRequest, "missing file")
		return "", false
	}
	defer file.Close()

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !allowed[ext] {
		httpError(w, http.StatusBadRequest, "unsupported file type")
		return "", false
	}

	dir := s.uploadDir
	pubPrefix := "/uploads/"
	if subdir != "" {
		dir = filepath.Join(s.uploadDir, subdir)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			httpError(w, http.StatusInternalServerError, "failed to prepare folder")
			return "", false
		}
		pubPrefix = "/uploads/" + subdir + "/"
	}

	name, err := randomName()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to name file")
		return "", false
	}
	name += ext
	dst, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to store file")
		return "", false
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to write file")
		return "", false
	}
	return pubPrefix + name, true
}

func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	path, ok := s.saveUpload(w, r, imageExts, maxImageBytes)
	if !ok {
		return
	}
	if err := s.st.SetAvatar(me.ID, path); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save avatar")
		return
	}
	me.AvatarPath = path
	s.broadcastProfile(me) // push the new photo to my partner's open screen
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// handleUploadNotifSound adds a sound to my collection. A new message plays one
// of my sounds at random, so I can keep several.
func (s *Server) handleUploadNotifSound(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	path, ok := s.saveUploadTo(w, r, audioExts, maxAudioBytes, "sounds")
	if !ok {
		return
	}
	sound, err := s.st.AddNotifSound(me.ID, path)
	if err != nil {
		s.removeUpload(path)
		httpError(w, http.StatusInternalServerError, "failed to save sound")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sound": sound})
}

// handleListNotifSounds returns my personal notification sounds.
func (s *Server) handleListNotifSounds(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	list, err := s.st.ListNotifSounds(me.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load sounds")
		return
	}
	if list == nil {
		list = []*store.NotifSound{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sounds": list})
}

// handleDeleteNotifSound removes one of my sounds (row + file).
func (s *Server) handleDeleteNotifSound(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	var req struct {
		ID int64 `json:"id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	path, err := s.st.DeleteNotifSound(me.ID, req.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to delete sound")
		return
	}
	if path != "" {
		s.removeUpload(path)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleUploadChatBG(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	path, ok := s.saveUpload(w, r, imageExts, maxImageBytes)
	if !ok {
		return
	}
	if err := s.st.SetChatBG(me.ID, path); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save background")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// handleUploadMessageImage stores an image to attach to a chat message and
// returns its path; the client then sends a normal WS message referencing it.
func (s *Server) handleUploadMessageImage(w http.ResponseWriter, r *http.Request) {
	path, ok := s.saveUpload(w, r, imageExts, maxImageBytes)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

// --- Stickers --------------------------------------------------------------

const maxStickerNameLen = 40

// handleListStickers returns every saved sticker (shared between both accounts).
func (s *Server) handleListStickers(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListStickers()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to load stickers")
		return
	}
	if list == nil {
		list = []*store.Sticker{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"stickers": list})
}

// handleUploadSticker saves a new sticker: an image or gif. The name is
// optional — the usual flow is to add the picture first and name it after —
// and can be set later with rename. Once saved it's available to both of us.
func (s *Server) handleUploadSticker(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	// The file is validated and stored first; an optional name rides alongside
	// it in the same multipart form (read after ParseMultipartForm in saveUploadTo).
	path, ok := s.saveUploadTo(w, r, imageExts, maxImageBytes, "stickers")
	if !ok {
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	if r := []rune(name); len(r) > maxStickerNameLen {
		name = string(r[:maxStickerNameLen])
	}
	// Make animated gifs loop forever, so a sticker keeps moving instead of
	// freezing after the file's own (possibly one-shot) loop count.
	if strings.HasSuffix(strings.ToLower(path), ".gif") {
		s.loopGifForever(path)
	}
	sticker, err := s.st.AddSticker(name, me.ID, path)
	if err != nil {
		s.removeUpload(path)
		httpError(w, http.StatusInternalServerError, "failed to save sticker")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sticker": sticker})
}

// handleRenameSticker sets (or changes) a sticker's name after the fact.
func (s *Server) handleRenameSticker(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if r := []rune(name); len(r) > maxStickerNameLen {
		name = string(r[:maxStickerNameLen])
	}
	if err := s.st.RenameSticker(req.ID, name); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to rename sticker")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": name})
}

// loopGifForever rewrites an animated gif so it loops endlessly. GIFs carry a
// loop count; some are authored to play once, which makes a sticker stop
// moving. Decoding and re-encoding with LoopCount 0 (infinite) fixes that. A
// non-gif or single-frame file is left untouched. Best-effort: any failure just
// leaves the original file as it was.
func (s *Server) loopGifForever(pubPath string) {
	rel := strings.TrimPrefix(pubPath, "/uploads/")
	full := filepath.Join(s.uploadDir, filepath.Clean("/"+rel))
	f, err := os.Open(full)
	if err != nil {
		return
	}
	g, err := gif.DecodeAll(f)
	f.Close()
	if err != nil || len(g.Image) <= 1 || g.LoopCount == 0 {
		return // not animated, or already loops forever
	}
	g.LoopCount = 0
	tmp := full + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return
	}
	if err := gif.EncodeAll(out, g); err != nil {
		out.Close()
		os.Remove(tmp)
		return
	}
	out.Close()
	os.Rename(tmp, full)
}

// handleDeleteSticker removes a sticker (row + file). Either partner may delete,
// since stickers are shared between the two of us.
func (s *Server) handleDeleteSticker(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID int64 `json:"id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	path, err := s.st.DeleteSticker(req.ID)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to delete sticker")
		return
	}
	if path != "" {
		s.removeUpload(path)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// removeUpload deletes a stored upload given its public "/uploads/..." path. It
// stays safely inside the upload directory and ignores anything that isn't an
// upload path.
func (s *Server) removeUpload(pubPath string) {
	if !strings.HasPrefix(pubPath, "/uploads/") {
		return
	}
	rel := strings.TrimPrefix(pubPath, "/uploads/")
	full := filepath.Join(s.uploadDir, filepath.Clean("/"+rel))
	if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
		log.Printf("could not remove upload %s: %v", pubPath, err)
	}
}

// --- small helpers ---------------------------------------------------------

func randomName() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// readJSON decodes the request body into v, writing a 400 on failure. It
// returns false if the caller should stop.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}
