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

// GardenRow is the raw persisted garden state (single row). The higher level
// garden package turns this into a view with tree stage, season, etc.
type GardenRow struct {
	Points        int    `json:"points"`
	StreakDays    int    `json:"streakDays"`
	LastActiveDay string `json:"lastActiveDay"` // YYYY-MM-DD, last day both of us chatted
	UpdatedAt     int64  `json:"updatedAt"`
}
