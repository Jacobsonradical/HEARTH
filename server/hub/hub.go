// Package hub is the realtime layer. It keeps track of the open WebSocket
// connections, pushes events (new messages, garden updates, presence) to both
// clients, and hands inbound frames back to the app via a callback.
package hub

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// InboundHandler is called for every text frame a client sends. The app uses
// it to turn "the user typed a message" into a persisted, broadcast message.
type InboundHandler func(userID int64, data []byte)

// client is one open browser connection.
type client struct {
	userID int64
	conn   *websocket.Conn
	send   chan []byte // buffered outbound queue for this connection
	status string      // "active" | "busy" | "away", reported by the browser
}

// statusRank lets us pick the "most present" status when a person has more than
// one connection open (e.g. phone + laptop). Higher wins.
var statusRank = map[string]int{"away": 1, "busy": 2, "active": 3}

// Hub owns all live connections. All map access goes through the mutex.
type Hub struct {
	mu      sync.Mutex
	clients map[*client]bool
	onMsg   InboundHandler
}

// New creates a hub with the given inbound-message handler.
func New(onMsg InboundHandler) *Hub {
	return &Hub{clients: map[*client]bool{}, onMsg: onMsg}
}

// upgrader turns an HTTP request into a WebSocket. We accept same-origin only;
// the browser always hits us on the LAN IP that also served the page, so the
// default same-origin check is exactly what we want.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = 50 * time.Second // must be < pongWait
	maxMsgSize = 8 * 1024         // chat frames are small (text + an image path)
)

// ServeWS upgrades the connection for an already-authenticated user and runs
// the read and write pumps until the socket closes.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request, userID int64) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade failed: %v", err)
		return
	}
	c := &client{userID: userID, conn: conn, send: make(chan []byte, 16), status: "active"}

	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()

	h.broadcastPresence()

	go h.writePump(c)
	h.readPump(c) // blocks until the connection drops
}

// readPump reads frames from one client and forwards them to the app.
func (h *Hub) readPump(c *client) {
	defer h.remove(c)

	c.conn.SetReadLimit(maxMsgSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return // client went away or protocol error; clean up via defer
		}
		// A couple of frame types are about the connection itself, not chat, so
		// the hub handles them directly instead of passing them to the app.
		var probe struct {
			Type   string `json:"type"`
			Status string `json:"status"`
		}
		if json.Unmarshal(data, &probe) == nil {
			switch probe.Type {
			case "status":
				h.setStatus(c, probe.Status)
				continue
			case "typing":
				// Tell the other side someone is typing; they filter their own id.
				h.Broadcast(map[string]any{"type": "typing", "userId": c.userID})
				continue
			}
		}
		if h.onMsg != nil {
			h.onMsg(c.userID, data)
		}
	}
}

// setStatus records a connection's presence status and, if it changed, tells
// everyone. Unknown status strings are ignored.
func (h *Hub) setStatus(c *client, status string) {
	if statusRank[status] == 0 {
		return
	}
	h.mu.Lock()
	changed := c.status != status
	c.status = status
	h.mu.Unlock()
	if changed {
		h.broadcastPresence()
	}
}

// writePump drains a client's send queue and keeps the connection alive with
// periodic pings.
func (h *Hub) writePump(c *client) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// remove drops a client and tells the other side that presence changed.
func (h *Hub) remove(c *client) {
	h.mu.Lock()
	if h.clients[c] {
		delete(h.clients, c)
		close(c.send)
		c.conn.Close()
	}
	h.mu.Unlock()
	h.broadcastPresence()
}

// Broadcast marshals event to JSON and sends it to every connected client.
func (h *Hub) Broadcast(event any) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("ws marshal failed: %v", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- data:
		default:
			// Slow/blocked client: drop it rather than stalling everyone.
			close(c.send)
			delete(h.clients, c)
			c.conn.Close()
		}
	}
}

// presenceUser is one person's aggregated presence.
type presenceUser struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

// presenceEvent tells clients who is connected and how present they are.
type presenceEvent struct {
	Type  string         `json:"type"`
	Users []presenceUser `json:"users"`
}

// broadcastPresence pushes everyone's current presence to all clients. A person
// with several connections is reported at their most-present status.
func (h *Hub) broadcastPresence() {
	h.mu.Lock()
	best := map[int64]string{}
	for c := range h.clients {
		if cur, ok := best[c.userID]; !ok || statusRank[c.status] > statusRank[cur] {
			best[c.userID] = c.status
		}
	}
	users := make([]presenceUser, 0, len(best))
	for id, st := range best {
		users = append(users, presenceUser{ID: id, Status: st})
	}
	h.mu.Unlock()
	h.Broadcast(presenceEvent{Type: "presence", Users: users})
}
