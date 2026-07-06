package api

// Local weather for the garden, fetched from the free Open-Meteo API (no key
// needed) and cached in memory so we only bother them every 15 minutes. The
// coordinates come from HEARTH_LAT / HEARTH_LON in the env; without them the
// endpoint reports enabled=false and the garden falls back to pleasant
// defaults. This is an OUTBOUND request from the server — the app itself stays
// LAN-only.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// weatherInfo is what the frontend receives.
type weatherInfo struct {
	Enabled    bool    `json:"enabled"`
	Kind       string  `json:"kind"` // clear | partly | cloudy | fog | rain | snow | storm
	Desc       string  `json:"desc"` // human words, e.g. "Light Rain"
	Place      string  `json:"place"`
	TempC      float64 `json:"tempC"`
	SunriseMin int     `json:"sunriseMin"` // minutes since local midnight
	SunsetMin  int     `json:"sunsetMin"`
	FetchedAt  int64   `json:"fetchedAt"`
}

type weatherService struct {
	lat, lon  string
	place     string // from env, or discovered along with the location
	mu        sync.Mutex
	cached    weatherInfo
	fresh     time.Time
	autoTried time.Time // last IP-geolocation attempt, to avoid hammering when offline
}

const weatherTTL = 15 * time.Minute

func newWeatherService(lat, lon, place string) *weatherService {
	return &weatherService{lat: lat, lon: lon, place: place}
}

// ipLocation is what the server can learn about itself from its public IP:
// where it roughly is, and which timezone that is in.
type ipLocation struct {
	Lat, Lon float64
	City     string
	Timezone string
}

// fetchIPLocation asks ipwho.is (free, no key) where this connection is.
func fetchIPLocation(timeout time.Duration) (*ipLocation, error) {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get("https://ipwho.is/")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var raw struct {
		Success   bool    `json:"success"`
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
		City      string  `json:"city"`
		Timezone  struct {
			ID string `json:"id"`
		} `json:"timezone"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}
	if !raw.Success {
		return nil, fmt.Errorf("ip lookup refused")
	}
	return &ipLocation{
		Lat: raw.Latitude, Lon: raw.Longitude,
		City: raw.City, Timezone: raw.Timezone.ID,
	}, nil
}

// AutoTimezone guesses the local timezone from the internet connection. Used
// at startup when no TZ was configured, so daily streaks and the garden's
// day/night cycle follow the real local day. Returns nil when offline or
// unsure — the caller then stays on UTC.
func AutoTimezone() *time.Location {
	info, err := fetchIPLocation(4 * time.Second)
	if err != nil || info.Timezone == "" {
		return nil
	}
	loc, err := time.LoadLocation(info.Timezone)
	if err != nil {
		return nil
	}
	return loc
}

// autoLocate fills in lat/lon (and the place name) from the server's public
// IP when no coordinates were configured. City-level accuracy — plenty for a
// weather mood. Runs at most once an hour until it succeeds; a VPN on the host
// can point this at the wrong city, in which case HEARTH_LAT/LON override it.
func (ws *weatherService) autoLocate() bool {
	if ws.lat != "" && ws.lon != "" {
		return true
	}
	if time.Since(ws.autoTried) < time.Hour {
		return false
	}
	ws.autoTried = time.Now()

	info, err := fetchIPLocation(8 * time.Second)
	if err != nil {
		log.Printf("weather: auto-locate failed: %v", err)
		return false
	}
	ws.lat = fmt.Sprintf("%.4f", info.Lat)
	ws.lon = fmt.Sprintf("%.4f", info.Lon)
	if ws.place == "" {
		ws.place = info.City
	}
	log.Printf("weather: auto-located to %s", info.City)
	return true
}

// kindForCode collapses WMO weather codes into the handful of moods the garden
// can actually draw.
func kindForCode(code int) string {
	switch {
	case code == 0:
		return "clear"
	case code <= 2:
		return "partly"
	case code == 3:
		return "cloudy"
	case code == 45 || code == 48:
		return "fog"
	case (code >= 51 && code <= 67) || (code >= 80 && code <= 82):
		return "rain"
	case (code >= 71 && code <= 77) || code == 85 || code == 86:
		return "snow"
	case code >= 95:
		return "storm"
	default:
		return "partly"
	}
}

// descForCode gives the weather in words, weather-app style.
func descForCode(code int) string {
	switch {
	case code == 0:
		return "Sunny"
	case code == 1:
		return "Mostly Clear"
	case code == 2:
		return "Partly Cloudy"
	case code == 3:
		return "Overcast"
	case code == 45 || code == 48:
		return "Fog"
	case code == 51:
		return "Light Drizzle"
	case code == 53 || code == 55:
		return "Drizzle"
	case code == 56 || code == 57:
		return "Freezing Drizzle"
	case code == 61 || code == 80:
		return "Light Rain"
	case code == 63 || code == 81:
		return "Rain"
	case code == 65 || code == 82:
		return "Heavy Rain"
	case code == 66 || code == 67:
		return "Freezing Rain"
	case code == 71 || code == 85:
		return "Light Snow"
	case code == 73 || code == 77:
		return "Snow"
	case code == 75 || code == 86:
		return "Heavy Snow"
	case code >= 96:
		return "Thunderstorm & Hail"
	case code == 95:
		return "Thunderstorm"
	default:
		return "Cloudy"
	}
}

// lookupPlace reverse-geocodes the coordinates to a locality name, once. Uses
// BigDataCloud's free client endpoint (no key). Failure just means the card
// shows "Home" — not worth retry machinery for a label.
func (ws *weatherService) lookupPlace() string {
	if ws.place != "" {
		return ws.place
	}
	url := fmt.Sprintf(
		"https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=%s&longitude=%s&localityLanguage=en",
		ws.lat, ws.lon)
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var raw struct {
		City     string `json:"city"`
		Locality string `json:"locality"`
	}
	if json.NewDecoder(resp.Body).Decode(&raw) != nil {
		return ""
	}
	if raw.City != "" {
		ws.place = raw.City // remember it; coordinates don't move
		return raw.City
	}
	ws.place = raw.Locality
	return raw.Locality
}

// minutesOfDay parses Open-Meteo's local ISO time ("2026-07-06T05:32") into
// minutes since midnight. Returns -1 if it doesn't look right.
func minutesOfDay(iso string) int {
	i := strings.IndexByte(iso, 'T')
	if i < 0 || len(iso) < i+6 {
		return -1
	}
	var h, m int
	if _, err := fmt.Sscanf(iso[i+1:i+6], "%d:%d", &h, &m); err != nil {
		return -1
	}
	return h*60 + m
}

// fetch calls Open-Meteo. timezone=auto makes sunrise/sunset come back in the
// location's own local time, which is exactly what the garden wants.
func (ws *weatherService) fetch() (weatherInfo, error) {
	url := fmt.Sprintf(
		"https://api.open-meteo.com/v1/forecast?latitude=%s&longitude=%s&current_weather=true&daily=sunrise,sunset&forecast_days=1&timezone=auto",
		ws.lat, ws.lon)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return weatherInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return weatherInfo{}, fmt.Errorf("weather api status %d", resp.StatusCode)
	}

	var raw struct {
		CurrentWeather struct {
			Temperature float64 `json:"temperature"`
			WeatherCode int     `json:"weathercode"`
		} `json:"current_weather"`
		Daily struct {
			Sunrise []string `json:"sunrise"`
			Sunset  []string `json:"sunset"`
		} `json:"daily"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return weatherInfo{}, err
	}

	info := weatherInfo{
		Enabled:   true,
		Kind:      kindForCode(raw.CurrentWeather.WeatherCode),
		Desc:      descForCode(raw.CurrentWeather.WeatherCode),
		Place:     ws.lookupPlace(),
		TempC:     raw.CurrentWeather.Temperature,
		FetchedAt: time.Now().UnixMilli(),
	}
	if len(raw.Daily.Sunrise) > 0 {
		info.SunriseMin = minutesOfDay(raw.Daily.Sunrise[0])
	}
	if len(raw.Daily.Sunset) > 0 {
		info.SunsetMin = minutesOfDay(raw.Daily.Sunset[0])
	}
	return info, nil
}

// current returns the cached weather, refreshing it when stale. Errors fall
// back to the previous cached value (or a disabled report) so a flaky internet
// connection never breaks the garden.
func (ws *weatherService) current() weatherInfo {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	// No coordinates configured? Find our own from the internet connection.
	if !ws.autoLocate() {
		return weatherInfo{Enabled: false}
	}
	if time.Since(ws.fresh) < weatherTTL && ws.cached.Enabled {
		return ws.cached
	}
	info, err := ws.fetch()
	if err != nil {
		log.Printf("weather fetch failed: %v", err)
		if ws.cached.Enabled {
			return ws.cached // stale beats broken
		}
		return weatherInfo{Enabled: false}
	}
	ws.cached = info
	ws.fresh = time.Now()
	return info
}

// handleWeather serves the garden's weather report.
func (s *Server) handleWeather(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.weather.current())
}
