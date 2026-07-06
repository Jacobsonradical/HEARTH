// Package garden holds the rules for our shared home space: how real
// interaction (chatting, watering, saying good morning) turns into growth
// points, and how those points map to a tree stage, flowers, and the season.
// All state lives in the store; this package is just the logic on top of it.
package garden

import (
	"time"

	"hearth/store"
)

// Point rewards. Tuned so the garden grows steadily but a milestone still feels
// earned. Kept as named constants so they are easy to find and adjust.
const (
	pointsPerMessage = 1  // a little life every time we talk
	pointsWater      = 5  // once per person per day
	pointsStreakDay  = 10 // both of us chatted on a new day
)

// Tree stages, from a buried seed to a grand tree. stageMins[i] is the minimum
// number of points needed to reach stage i.
var (
	stageNames = []string{"seed", "sprout", "seedling", "young tree", "tree", "blossoming tree", "grand tree"}
	stageMins  = []int{0, 20, 60, 120, 250, 450, 750}
)

const (
	pointsPerFlower = 25 // one bloom for every this-many points
	maxFlowers      = 24 // cap so the garden doesn't overflow the screen
)

// Shared is the part of the garden that looks the same to both of us. It is
// what we push over the WebSocket when the garden changes.
type Shared struct {
	Type       string `json:"type"` // always "garden" when broadcast
	Points     int    `json:"points"`
	StreakDays int    `json:"streakDays"`
	TreeStage  int    `json:"treeStage"`
	MaxStage   int    `json:"maxStage"`
	StageName  string `json:"stageName"`
	Flowers    int    `json:"flowers"`
	Season     string `json:"season"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// View adds the flag that depends on who is looking: whether *I* can still water
// the garden today.
type View struct {
	Shared
	CanWaterToday bool `json:"canWaterToday"`
}

// today returns the current local calendar day as YYYY-MM-DD.
func today() string { return time.Now().Format("2006-01-02") }

// dayBoundsMs returns [start, end) in unix milliseconds for the local day that
// contains t. Used to ask the store who chatted "today".
func dayBoundsMs(t time.Time) (int64, int64) {
	y, m, d := t.Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, t.Location())
	return start.UnixMilli(), start.AddDate(0, 0, 1).UnixMilli()
}

// stageForPoints returns the tree stage index for a point total.
func stageForPoints(points int) int {
	stage := 0
	for i, min := range stageMins {
		if points >= min {
			stage = i
		}
	}
	return stage
}

// flowersForPoints returns the number of blooms to draw for a point total.
func flowersForPoints(points int) int {
	f := points / pointsPerFlower
	if f > maxFlowers {
		f = maxFlowers
	}
	return f
}

// seasonForMonth maps a calendar month to a season (northern hemisphere).
func seasonForMonth(mon time.Month) string {
	switch mon {
	case time.December, time.January, time.February:
		return "winter"
	case time.March, time.April, time.May:
		return "spring"
	case time.June, time.July, time.August:
		return "summer"
	default:
		return "autumn"
	}
}

// buildShared turns a persisted garden row into the shared view.
func buildShared(g *store.GardenRow) Shared {
	stage := stageForPoints(g.Points)
	return Shared{
		Type:       "garden",
		Points:     g.Points,
		StreakDays: g.StreakDays,
		TreeStage:  stage,
		MaxStage:   len(stageNames) - 1,
		StageName:  stageNames[stage],
		Flowers:    flowersForPoints(g.Points),
		Season:     seasonForMonth(time.Now().Month()),
		UpdatedAt:  g.UpdatedAt,
	}
}

// SharedView reads the current shared garden state (for broadcasting).
func SharedView(st *store.Store) (Shared, error) {
	g, err := st.Garden()
	if err != nil {
		return Shared{}, err
	}
	return buildShared(g), nil
}

// ViewFor reads the full garden state as seen by a specific user.
func ViewFor(st *store.Store, userID int64) (View, error) {
	shared, err := SharedView(st)
	if err != nil {
		return View{}, err
	}
	watered, err := st.HasAction(userID, today(), "water")
	if err != nil {
		return View{}, err
	}
	return View{Shared: shared, CanWaterToday: !watered}, nil
}

// Water records today's watering for a user. It returns the updated view and
// whether anything actually changed (false if they already watered today).
func Water(st *store.Store, userID int64) (View, bool, error) {
	newly, err := st.RecordAction(userID, today(), "water")
	if err != nil {
		return View{}, false, err
	}
	if newly {
		if err := st.AddPoints(pointsWater); err != nil {
			return View{}, false, err
		}
	}
	v, err := ViewFor(st, userID)
	return v, newly, err
}

// OnMessage is called after a chat message is stored. It grants a small
// per-message point and, when both of us have chatted on a new day, advances
// the streak. It returns whether the *visible* garden changed (tree stage,
// flower count, or streak) so the caller knows whether to broadcast an update.
func OnMessage(st *store.Store) (bool, error) {
	g, err := st.Garden()
	if err != nil {
		return false, err
	}
	beforeStage := stageForPoints(g.Points)
	beforeFlowers := flowersForPoints(g.Points)
	beforeStreak := g.StreakDays

	g.Points += pointsPerMessage

	// Streak: did both of us send at least one message today?
	now := time.Now()
	start, end := dayBoundsMs(now)
	senders, err := st.SendersOnDay(start, end)
	if err != nil {
		return false, err
	}
	day := today()
	if len(senders) >= 2 && g.LastActiveDay != day {
		yesterday := now.AddDate(0, 0, -1).Format("2006-01-02")
		if g.LastActiveDay == yesterday {
			g.StreakDays++
		} else {
			g.StreakDays = 1
		}
		g.LastActiveDay = day
		g.Points += pointsStreakDay
	}

	if err := st.SaveGarden(g); err != nil {
		return false, err
	}

	changed := stageForPoints(g.Points) != beforeStage ||
		flowersForPoints(g.Points) != beforeFlowers ||
		g.StreakDays != beforeStreak
	return changed, nil
}
