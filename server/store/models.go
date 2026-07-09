package store

// User is one of the two fixed accounts. Profile fields (display name, avatar,
// sounds, background) are customizable in-app; credentials come from the env.
type User struct {
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	AvatarPath   string `json:"avatarPath"`
	NotifSound   string `json:"notifSound"`
	ChatBGPath   string `json:"chatBg"`
	PasswordHash string `json:"-"`
}

// Message is a single chat line. Body may be empty when the message is only an
// image; ImagePath may be empty for a plain text message.
type Message struct {
	ID        int64  `json:"id"`
	SenderID  int64  `json:"senderId"`
	Body      string `json:"body"`
	ImagePath string `json:"imagePath"`
	CreatedAt int64  `json:"createdAt"` // unix milliseconds
}

// NotifSound is one of a user's personal notification sounds. Each account can
// have several; a new message plays one at random.
type NotifSound struct {
	ID        int64  `json:"id"`
	Path      string `json:"path"`
	CreatedAt int64  `json:"createdAt"` // unix milliseconds
}

// Sticker is a saved 表情包 (a figure or gif) with a searchable name. Stickers
// are shared: whoever adds one, both accounts can send it. The file lives under
// <data>/uploads/stickers/, so it's covered by the normal backup.
type Sticker struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	OwnerID   int64  `json:"ownerId"`
	Path      string `json:"path"`
	CreatedAt int64  `json:"createdAt"` // unix milliseconds
}

// GamePlay is one finished game in the recent-plays feed: who played, their
// score, and when (unix milliseconds).
type GamePlay struct {
	Name  string `json:"name"`
	Score int    `json:"score"`
	At    int64  `json:"at"`
}

// GardenRow is the raw persisted garden state (single row). The higher level
// garden package turns this into a view with tree stage, season, etc.
type GardenRow struct {
	Points        int    `json:"points"`
	StreakDays    int    `json:"streakDays"`
	LastActiveDay string `json:"lastActiveDay"` // YYYY-MM-DD, last day both of us chatted
	UpdatedAt     int64  `json:"updatedAt"`
}
