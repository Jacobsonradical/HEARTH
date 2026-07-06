// Package api wires the HTTP and WebSocket endpoints to the store, auth, hub,
// and garden packages. It is the seam between "browser requests" and "app
// logic": handlers here validate input, call into the other packages, and
// shape the JSON responses.
package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	mux.Handle("POST /api/upload/chat-bg", s.protect(s.handleUploadChatBG))
	mux.Handle("POST /api/upload/message-image", s.protect(s.handleUploadMessageImage))
	mux.Handle("GET /api/garden", s.protect(s.handleGarden))
	mux.Handle("GET /api/weather", s.protect(s.handleWeather))
	mux.Handle("POST /api/garden/water", s.protect(s.handleWater))
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

// saveUpload reads the "file" field of a multipart form, validates its
// extension against allowed, enforces maxBytes, and writes it into the upload
// directory under a random name. It returns the public "/uploads/..." path.
func (s *Server) saveUpload(w http.ResponseWriter, r *http.Request, allowed map[string]bool, maxBytes int64) (string, bool) {
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

	name, err := randomName()
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to name file")
		return "", false
	}
	name += ext
	dst, err := os.Create(filepath.Join(s.uploadDir, name))
	if err != nil {
		httpError(w, http.StatusInternalServerError, "failed to store file")
		return "", false
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to write file")
		return "", false
	}
	return "/uploads/" + name, true
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

func (s *Server) handleUploadNotifSound(w http.ResponseWriter, r *http.Request) {
	me := auth.UserFrom(r.Context())
	path, ok := s.saveUpload(w, r, audioExts, maxAudioBytes)
	if !ok {
		return
	}
	if err := s.st.SetNotifSound(me.ID, path); err != nil {
		httpError(w, http.StatusInternalServerError, "failed to save sound")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
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
