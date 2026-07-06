// Command hearth is the whole backend: it seeds the two fixed accounts, opens
// the SQLite database, serves the built React frontend, and runs the chat +
// garden API over HTTP and WebSocket. One binary, one container, one data dir.
package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hearth/api"
	"hearth/auth"
	"hearth/store"
)

// config is the full runtime configuration, all sourced from the environment so
// nothing sensitive is baked into the image.
type config struct {
	addr     string
	dataDir  string
	webDir   string
	lat, lon string // optional, for the garden's local weather
	place    string // optional label for the weather card
	accounts [2]account
}

type account struct {
	username    string
	password    string
	displayName string
}

func loadConfig() config {
	return config{
		addr:    env("HEARTH_ADDR", ":3000"),
		dataDir: env("HEARTH_DATA_DIR", "./data"),
		webDir:  env("HEARTH_WEB_DIR", "./web/dist"),
		lat:     env("HEARTH_LAT", ""),
		lon:     env("HEARTH_LON", ""),
		place:   env("HEARTH_PLACE", ""),
		accounts: [2]account{
			{env("HEARTH_USER1", ""), env("HEARTH_PASS1", ""), env("HEARTH_NAME1", "")},
			{env("HEARTH_USER2", ""), env("HEARTH_PASS2", ""), env("HEARTH_NAME2", "")},
		},
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("hearth: ")

	cfg := loadConfig()

	// No timezone configured? Find it from the internet connection, so streaks
	// and the garden's day/night cycle follow the real local day even on hosts
	// that never set TZ (e.g. a default Windows/WSL install). Offline at boot
	// simply means UTC until the next restart — nothing breaks.
	if os.Getenv("TZ") == "" {
		if loc := api.AutoTimezone(); loc != nil {
			time.Local = loc
			log.Printf("timezone auto-detected: %s (set TZ in .env to override)", loc)
		} else {
			log.Printf("timezone: could not auto-detect, using UTC (set TZ in .env)")
		}
	}

	// Make sure the data folder and its uploads subfolder exist. This folder is
	// the single source of truth for backup/restore.
	uploadDir := filepath.Join(cfg.dataDir, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		log.Fatalf("cannot create data dir: %v", err)
	}

	st, err := store.Open(filepath.Join(cfg.dataDir, "hearth.db"))
	if err != nil {
		log.Fatalf("cannot open database: %v", err)
	}
	defer st.Close()

	if err := seedAccounts(st, cfg); err != nil {
		log.Fatalf("cannot seed accounts: %v", err)
	}

	server := api.New(st, uploadDir, cfg.lat, cfg.lon, cfg.place)

	mux := http.NewServeMux()
	server.Mount(mux)
	// Anything not claimed by an API/upload/ws route is the frontend.
	mux.Handle("/", spaHandler(cfg.webDir))

	httpServer := &http.Server{
		Addr:              cfg.addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the WebSocket connection is long-lived.
	}

	log.Printf("listening on %s (data: %s)", cfg.addr, cfg.dataDir)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

// seedAccounts reconciles the users table with the two accounts in the env.
// The app must always hold EXACTLY these two people, whatever the database
// looked like before. Three situations are handled:
//   - account already exists      -> refresh its password hash from the env
//   - username changed in the env -> adopt the old row (rename it), keeping
//     the person's message history; the row with the most messages is chosen
//   - anything else left over     -> pruned. This heals databases that grew
//     extra accounts from an earlier run with template .env values, which
//     broke everything "partner"-shaped (presence, avatars) by making the
//     app pick a dead account as the partner.
func seedAccounts(st *store.Store, cfg config) error {
	// No accounts in the env at all? Then the app runs in first-open setup
	// mode: the two accounts are created from the setup screen in the browser
	// and live only in the database. (Setting the env vars later still works,
	// e.g. to reset a forgotten password.)
	allEmpty := true
	for _, a := range cfg.accounts {
		if a.username != "" || a.password != "" {
			allEmpty = false
		}
	}
	if allEmpty {
		return nil
	}

	for _, a := range cfg.accounts {
		if a.username == "" || a.password == "" {
			return errors.New("HEARTH_USER/PASS must be set for both accounts, or left empty for both (see .env.example)")
		}
	}
	if cfg.accounts[0].username == cfg.accounts[1].username {
		return errors.New("the two accounts must have different usernames")
	}

	users, err := st.AllUsers()
	if err != nil {
		return err
	}
	byName := map[string]*store.User{}
	for _, u := range users {
		byName[u.Username] = u
	}
	isEnvName := func(name string) bool {
		return name == cfg.accounts[0].username || name == cfg.accounts[1].username
	}
	claimed := map[int64]bool{} // rows already settled on an env account

	for i, a := range cfg.accounts {
		name := a.displayName
		if name == "" {
			name = a.username
		}
		hash, err := auth.HashPassword(a.password)
		if err != nil {
			return err
		}

		// Simple case: the username already has a row. Keep its in-app profile,
		// just refresh the hash from the env.
		if u, ok := byName[a.username]; ok {
			claimed[u.ID] = true
			if err := st.SetPasswordHash(u.ID, hash); err != nil {
				return err
			}
			continue
		}

		// The username is new. If an unclaimed old row exists, this is a rename:
		// adopt the row so the person keeps their history. When several old rows
		// qualify, prefer the one that actually holds messages.
		var adopt *store.User
		best := -1
		for _, u := range users {
			if claimed[u.ID] || isEnvName(u.Username) {
				continue
			}
			n, err := st.MessageCount(u.ID)
			if err != nil {
				return err
			}
			if n > best {
				best = n
				adopt = u
			}
		}
		if adopt != nil {
			claimed[adopt.ID] = true
			if err := st.RenameUser(adopt.ID, a.username, hash, name); err != nil {
				return err
			}
			log.Printf("account %d: renamed %q -> %q (history kept)", i+1, adopt.Username, a.username)
			continue
		}

		id, err := st.CreateUser(a.username, hash, name)
		if err != nil {
			return err
		}
		claimed[id] = true
		log.Printf("account %d: created %s", i+1, a.username)
	}

	// Prune whatever is left: rows that are neither env account by now can only
	// be stale (both env accounts are settled above without needing them).
	users, err = st.AllUsers()
	if err != nil {
		return err
	}
	for _, u := range users {
		if isEnvName(u.Username) {
			continue
		}
		n, _ := st.MessageCount(u.ID)
		if err := st.DeleteUserDeep(u.ID); err != nil {
			return err
		}
		log.Printf("pruned stale account %q (%d messages removed)", u.Username, n)
	}
	return nil
}

// spaHandler serves the built single-page app. Real files are served as-is;
// any other (non-API) path falls back to index.html so client-side routing and
// deep links work. Unknown /api paths get a clean 404 instead of the HTML shell.
func spaHandler(webDir string) http.HandlerFunc {
	root := http.Dir(webDir)
	fileServer := http.FileServer(root)
	indexPath := filepath.Join(webDir, "index.html")

	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		// Does a real file exist for this path? If so, serve it.
		clean := filepath.Clean(r.URL.Path)
		if f, err := root.Open(clean); err == nil {
			f.Close()
			// Never cache the HTML shell, so a rebuild is picked up on the next
			// visit. The bundled JS/CSS under /assets/ have content-hashed names,
			// so they bust their own cache and are safe to let the browser keep.
			if clean == "/" || strings.HasSuffix(clean, ".html") {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		// Otherwise hand back the app shell (also uncached).
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, indexPath)
	}
}
