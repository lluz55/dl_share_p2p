package main

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"time"
)

// Peer represents a connected participant in a room.
type Peer struct {
	ID       string      `json:"id"`
	Role     string      `json:"role"` // "host" or "guest"
	Send     chan []byte `json:"-"`
	RoomCode string      `json:"room_code"`
	IP       string      `json:"-"`
}

// Room represents a signaling room with a host and guests.
type Room struct {
	Code       string           `json:"code"`
	Peers      map[string]*Peer `json:"peers"`
	HostID     string           `json:"host_id"`
	HostIP     string           `json:"host_ip"`
	CreatedAt  time.Time        `json:"created_at"`
	LastActive time.Time        `json:"last_active"`
	MaxMembers int              `json:"max_members"`
}

// Word list for generating room codes.
// TODO(SPEC §11.3): finalize the word list source and size to ensure sufficient entropy.
var wordList = []string{
	"amber", "ancient", "anchor", "arrow", "autumn", "badge", "beacon", "bison", "blaze", "breeze",
	"bright", "bronze", "canyon", "castle", "cedar", "cherry", "cliff", "cobalt", "comet", "copper",
	"cosmic", "crag", "crater", "crest", "crystal", "desert", "dolphin", "dusk", "eagle", "earth",
	"echo", "ember", "falcon", "fawn", "feather", "flame", "forest", "fossil", "frost", "galaxy",
	"garden", "geyser", "glacier", "glow", "gold", "granite", "gravel", "harbor", "haven", "hawk",
	"hazel", "heather", "heron", "hill", "honey", "horizon", "island", "ivy", "jade", "jasper",
	"jungle", "lake", "leaf", "lemon", "lime", "lizard", "lunar", "maple", "meadow", "mirror",
	"mist", "moss", "mount", "nebula", "novel", "oak", "oasis", "ocean", "olive", "opal",
	"orbit", "orchid", "otter", "owl", "ozone", "panther", "pebble", "pine", "pioneer", "planet",
	"plum", "pond", "prism", "quartz", "radar", "rain", "rapid", "raven", "reef", "riddle",
	"river", "ruby", "rust", "sable", "safari", "salmon", "scale", "sea", "seeker", "shadow",
	"shield", "shore", "silent", "silver", "sky", "slate", "snow", "solar", "sonic", "spark",
	"spire", "spring", "spruce", "star", "stone", "storm", "summit", "sun", "swift", "tiger",
	"timber", "topaz", "trail", "tundra", "valley", "velvet", "vessel", "vibrant", "vine", "violet",
	"volcano", "vortex", "voyager", "walnut", "wave", "weaver", "wild", "wind", "wolf", "zenith",
	"zephyr",
}

// GenerateRoomCode generates a three-word code joined by hyphens.
func GenerateRoomCode() (string, error) {
	n := len(wordList)
	indices := make([]int, 3)
	for i := 0; i < 3; i++ {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		val := binary.BigEndian.Uint32(b)
		indices[i] = int(val % uint32(n))
	}
	return fmt.Sprintf("%s-%s-%s", wordList[indices[0]], wordList[indices[1]], wordList[indices[2]]), nil
}
