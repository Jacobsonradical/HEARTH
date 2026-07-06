// Package auth handles passwords, login sessions, and the middleware that
// guards protected routes. Security model is deliberately simple: two fixed
// accounts on a LAN, bcrypt-hashed passwords, and a long-lived session cookie
// so logins survive browser restarts.
package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"

	"hearth/store"
)

// CookieName is the session cookie key. Kept short and unremarkable.
const CookieName = "hearth_session"

// SessionTTL is how long a login stays valid. A year is plenty for a home app
// and means we effectively never get logged out on our own devices.
const SessionTTL = 365 * 24 * time.Hour

type ctxKey int

const userKey ctxKey = 0

// HashPassword returns a bcrypt hash suitable for storage.
func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(b), err
}

// CheckPassword reports whether plain matches the stored bcrypt hash.
func CheckPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}

// newToken returns a random, URL-safe session token.
func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Login verifies the credentials, creates a session, and writes the cookie.
// It returns the authenticated user on success.
func Login(w http.ResponseWriter, r *http.Request, st *store.Store, username, password string) (*store.User, error) {
	u, err := st.UserByUsername(username)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("invalid username or password")
	}
	if err != nil {
		return nil, err
	}
	if !CheckPassword(u.PasswordHash, password) {
		return nil, errors.New("invalid username or password")
	}

	token, err := newToken()
	if err != nil {
		return nil, err
	}
	expires := time.Now().Add(SessionTTL)
	if err := st.CreateSession(token, u.ID, expires.UnixMilli()); err != nil {
		return nil, err
	}
	setCookie(w, r, token, expires)
	return u, nil
}

// Logout clears the current session (both server-side and the cookie).
func Logout(w http.ResponseWriter, r *http.Request, st *store.Store) {
	if c, err := r.Cookie(CookieName); err == nil {
		st.DeleteSession(c.Value)
	}
	setCookie(w, r, "", time.Unix(0, 0)) // expire immediately
}

// setCookie writes the session cookie. It is HttpOnly (JS can't read it) and
// SameSite=Lax. We intentionally do NOT set Secure: v1 runs over plain HTTP on
// the home wifi. When HTTPS is added later, flip Secure on here.
func setCookie(w http.ResponseWriter, r *http.Request, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// Middleware wraps a handler and requires a valid session. On failure it
// returns 401 so the frontend can redirect to the login screen. On success the
// authenticated user is stored in the request context.
func Middleware(st *store.Store, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(CookieName)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		u, err := st.UserForSession(c.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), userKey, u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// UserFrom pulls the authenticated user out of the request context. It is only
// valid inside handlers wrapped by Middleware.
func UserFrom(ctx context.Context) *store.User {
	u, _ := ctx.Value(userKey).(*store.User)
	return u
}
