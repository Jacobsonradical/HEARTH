// Package store owns everything that touches SQLite: opening the database,
// creating the schema, and every query the rest of the app runs. Keeping all
// SQL in one place makes the data layer easy to read and reason about.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure-Go SQLite driver, registered as "sqlite"
)

// Store wraps the database handle. There is exactly one per running app.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the SQLite database at path and applies the
// schema. WAL mode gives us safe concurrent reads while a write is in flight,
// and a busy timeout avoids spurious "database is locked" errors.
func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite is a single file; one writer at a time keeps things simple and
	// avoids lock contention in this tiny two-user app.
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

// migrate creates all tables if they do not already exist. The schema is small
// enough that a single idempotent block is clearer than a migration framework.
func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    avatar_path   TEXT NOT NULL DEFAULT '',
    notif_sound   TEXT NOT NULL DEFAULT '',
    chat_bg_path  TEXT NOT NULL DEFAULT ''
);

-- A nickname is what one person privately calls the other. It is only ever
-- shown to the viewer who set it, hence the (viewer, target) key.
CREATE TABLE IF NOT EXISTS nicknames (
    viewer_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    nickname  TEXT NOT NULL,
    PRIMARY KEY (viewer_id, target_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id  INTEGER NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    image_path TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Single-row table (id is pinned to 1) holding cumulative garden state.
CREATE TABLE IF NOT EXISTS garden (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    points          INTEGER NOT NULL DEFAULT 0,
    streak_days     INTEGER NOT NULL DEFAULT 0,
    last_active_day TEXT NOT NULL DEFAULT '',
    updated_at      INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO garden (id, points, streak_days, last_active_day, updated_at)
    VALUES (1, 0, 0, '', 0);

-- Once-per-day-per-person actions that feed the garden (watering, good morning).
CREATE TABLE IF NOT EXISTS garden_actions (
    user_id INTEGER NOT NULL,
    day     TEXT NOT NULL,   -- YYYY-MM-DD in the server's local time
    action  TEXT NOT NULL,   -- 'water' | 'good_morning'
    PRIMARY KEY (user_id, day, action)
);

-- How far each of us has read the conversation, so we can draw an "unread"
-- marker. Advanced only while a person is actually looking at the chat.
CREATE TABLE IF NOT EXISTS read_state (
    user_id      INTEGER PRIMARY KEY,
    last_read_id INTEGER NOT NULL DEFAULT 0
);
`
	_, err := s.db.Exec(schema)
	return err
}

// --- Users -----------------------------------------------------------------

// UserByUsername returns the user with the given login name, or sql.ErrNoRows.
func (s *Store) UserByUsername(username string) (*User, error) {
	return s.scanUser(s.db.QueryRow(
		`SELECT id, username, password_hash, display_name, avatar_path, notif_sound, chat_bg_path
		 FROM users WHERE username = ?`, username))
}

// UserByID returns the user with the given id, or sql.ErrNoRows.
func (s *Store) UserByID(id int64) (*User, error) {
	return s.scanUser(s.db.QueryRow(
		`SELECT id, username, password_hash, display_name, avatar_path, notif_sound, chat_bg_path
		 FROM users WHERE id = ?`, id))
}

// AllUsers returns both accounts ordered by id (used to find "the partner").
func (s *Store) AllUsers() ([]*User, error) {
	rows, err := s.db.Query(
		`SELECT id, username, password_hash, display_name, avatar_path, notif_sound, chat_bg_path
		 FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.DisplayName,
			&u.AvatarPath, &u.NotifSound, &u.ChatBGPath); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) scanUser(row *sql.Row) (*User, error) {
	u := &User{}
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.DisplayName,
		&u.AvatarPath, &u.NotifSound, &u.ChatBGPath)
	if err != nil {
		return nil, err
	}
	return u, nil
}

// UserCount returns how many accounts exist (0 means first-run setup is due).
func (s *Store) UserCount() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser inserts a new account and returns its id.
func (s *Store) CreateUser(username, passwordHash, displayName string) (int64, error) {
	res, err := s.db.Exec(
		`INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)`,
		username, passwordHash, displayName)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SetPasswordHash overwrites a user's stored hash. Used at startup so the env
// stays the single source of truth for credentials.
func (s *Store) SetPasswordHash(id int64, hash string) error {
	_, err := s.db.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, hash, id)
	return err
}

// RenameUser repurposes an existing account row for a new login name. The row
// id is kept, so the person's message history, garden actions, and read state
// all survive a username change in the env.
func (s *Store) RenameUser(id int64, username, hash, displayName string) error {
	_, err := s.db.Exec(
		`UPDATE users SET username = ?, password_hash = ?, display_name = ? WHERE id = ?`,
		username, hash, displayName, id)
	return err
}

// MessageCount returns how many messages a user has sent. Used at startup to
// decide which existing row a renamed account should adopt.
func (s *Store) MessageCount(userID int64) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE sender_id = ?`, userID).Scan(&n)
	return n, err
}

// DeleteUserDeep removes an account and everything tied to it: sessions,
// nicknames (in both directions), read state, garden actions, and messages.
// Used at startup to prune stale accounts (e.g. leftovers from a template
// .env) so the app always holds exactly the two configured people.
func (s *Store) DeleteUserDeep(id int64) error {
	stmts := []string{
		`DELETE FROM sessions WHERE user_id = ?`,
		`DELETE FROM nicknames WHERE viewer_id = ? OR target_id = ?`,
		`DELETE FROM read_state WHERE user_id = ?`,
		`DELETE FROM garden_actions WHERE user_id = ?`,
		`DELETE FROM messages WHERE sender_id = ?`,
		`DELETE FROM users WHERE id = ?`,
	}
	for _, q := range stmts {
		var err error
		if strings.Contains(q, "OR target_id") {
			_, err = s.db.Exec(q, id, id)
		} else {
			_, err = s.db.Exec(q, id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// SetDisplayName updates the account's own display name.
func (s *Store) SetDisplayName(id int64, name string) error {
	_, err := s.db.Exec(`UPDATE users SET display_name = ? WHERE id = ?`, name, id)
	return err
}

// SetAvatar stores the path to a freshly uploaded avatar image.
func (s *Store) SetAvatar(id int64, path string) error {
	_, err := s.db.Exec(`UPDATE users SET avatar_path = ? WHERE id = ?`, path, id)
	return err
}

// SetNotifSound stores the path to a freshly uploaded notification sound.
func (s *Store) SetNotifSound(id int64, path string) error {
	_, err := s.db.Exec(`UPDATE users SET notif_sound = ? WHERE id = ?`, path, id)
	return err
}

// SetChatBG stores the path to a freshly uploaded chat background image.
func (s *Store) SetChatBG(id int64, path string) error {
	_, err := s.db.Exec(`UPDATE users SET chat_bg_path = ? WHERE id = ?`, path, id)
	return err
}

// --- Nicknames -------------------------------------------------------------

// Nickname returns the private name viewer has set for target, or "" if none.
func (s *Store) Nickname(viewerID, targetID int64) (string, error) {
	var nick string
	err := s.db.QueryRow(
		`SELECT nickname FROM nicknames WHERE viewer_id = ? AND target_id = ?`,
		viewerID, targetID).Scan(&nick)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return nick, err
}

// SetNickname upserts the private nickname viewer uses for target. An empty
// nickname clears it.
func (s *Store) SetNickname(viewerID, targetID int64, nickname string) error {
	if nickname == "" {
		_, err := s.db.Exec(
			`DELETE FROM nicknames WHERE viewer_id = ? AND target_id = ?`,
			viewerID, targetID)
		return err
	}
	_, err := s.db.Exec(
		`INSERT INTO nicknames (viewer_id, target_id, nickname) VALUES (?, ?, ?)
		 ON CONFLICT(viewer_id, target_id) DO UPDATE SET nickname = excluded.nickname`,
		viewerID, targetID, nickname)
	return err
}

// --- Messages --------------------------------------------------------------

// AddMessage persists a new chat message and returns the stored row (with id
// and timestamp filled in).
func (s *Store) AddMessage(senderID int64, body, imagePath string) (*Message, error) {
	now := time.Now().UnixMilli()
	res, err := s.db.Exec(
		`INSERT INTO messages (sender_id, body, image_path, created_at) VALUES (?, ?, ?, ?)`,
		senderID, body, imagePath, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Message{ID: id, SenderID: senderID, Body: body, ImagePath: imagePath, CreatedAt: now}, nil
}

// RecentMessages returns up to limit messages with id < before, newest first.
// Pass before = 0 to start from the most recent message. The caller typically
// reverses the slice for display (oldest at top).
func (s *Store) RecentMessages(before int64, limit int) ([]*Message, error) {
	if before <= 0 {
		before = 1<<63 - 1 // effectively "no upper bound"
	}
	rows, err := s.db.Query(
		`SELECT id, sender_id, body, image_path, created_at
		 FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Message
	for rows.Next() {
		m := &Message{}
		if err := rows.Scan(&m.ID, &m.SenderID, &m.Body, &m.ImagePath, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// SendersOnDay returns the distinct set of user ids who sent at least one
// message on the given local day (YYYY-MM-DD). Used to detect "both of us
// chatted today" for the streak.
func (s *Store) SendersOnDay(dayStartMs, dayEndMs int64) (map[int64]bool, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT sender_id FROM messages WHERE created_at >= ? AND created_at < ?`,
		dayStartMs, dayEndMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		set[id] = true
	}
	return set, rows.Err()
}

// --- Sessions --------------------------------------------------------------

// CreateSession stores a login session token valid until expiresAt (unix ms).
func (s *Store) CreateSession(token string, userID, expiresAt int64) error {
	_, err := s.db.Exec(
		`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		token, userID, time.Now().UnixMilli(), expiresAt)
	return err
}

// UserForSession returns the user behind a still-valid session token, or
// sql.ErrNoRows if the token is unknown or expired.
func (s *Store) UserForSession(token string) (*User, error) {
	var userID, expiresAt int64
	err := s.db.QueryRow(
		`SELECT user_id, expires_at FROM sessions WHERE token = ?`, token).Scan(&userID, &expiresAt)
	if err != nil {
		return nil, err
	}
	if time.Now().UnixMilli() > expiresAt {
		s.DeleteSession(token) // opportunistic cleanup of the expired token
		return nil, sql.ErrNoRows
	}
	return s.UserByID(userID)
}

// DeleteSession removes a session (logout, or expiry cleanup).
func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token = ?`, token)
	return err
}

// --- Read state ------------------------------------------------------------

// LastReadID returns the id of the last message the user has read (0 if never).
func (s *Store) LastReadID(userID int64) (int64, error) {
	var id int64
	err := s.db.QueryRow(`SELECT last_read_id FROM read_state WHERE user_id = ?`, userID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return id, err
}

// SetLastReadID advances the user's read marker. It never moves backward, so an
// out-of-order request can't "unread" already-seen messages.
func (s *Store) SetLastReadID(userID, id int64) error {
	_, err := s.db.Exec(
		`INSERT INTO read_state (user_id, last_read_id) VALUES (?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
		userID, id)
	return err
}

// --- Garden ----------------------------------------------------------------

// Garden returns the single garden state row.
func (s *Store) Garden() (*GardenRow, error) {
	g := &GardenRow{}
	err := s.db.QueryRow(
		`SELECT points, streak_days, last_active_day, updated_at FROM garden WHERE id = 1`).
		Scan(&g.Points, &g.StreakDays, &g.LastActiveDay, &g.UpdatedAt)
	return g, err
}

// SaveGarden writes back the garden state, stamping updated_at.
func (s *Store) SaveGarden(g *GardenRow) error {
	_, err := s.db.Exec(
		`UPDATE garden SET points = ?, streak_days = ?, last_active_day = ?, updated_at = ? WHERE id = 1`,
		g.Points, g.StreakDays, g.LastActiveDay, time.Now().UnixMilli())
	return err
}

// AddPoints increments the garden's cumulative growth points.
func (s *Store) AddPoints(delta int) error {
	_, err := s.db.Exec(
		`UPDATE garden SET points = points + ?, updated_at = ? WHERE id = 1`,
		delta, time.Now().UnixMilli())
	return err
}

// HasAction reports whether user already performed action on the given day.
func (s *Store) HasAction(userID int64, day, action string) (bool, error) {
	var one int
	err := s.db.QueryRow(
		`SELECT 1 FROM garden_actions WHERE user_id = ? AND day = ? AND action = ?`,
		userID, day, action).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// RecordAction stores a once-per-day action. Returns false (without error) if
// the action was already recorded for that user and day.
func (s *Store) RecordAction(userID int64, day, action string) (bool, error) {
	res, err := s.db.Exec(
		`INSERT OR IGNORE INTO garden_actions (user_id, day, action) VALUES (?, ?, ?)`,
		userID, day, action)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
