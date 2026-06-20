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
// Resolved SPEC §11.3: using 160 Portuguese ASCII-only lowercase words.
var wordList = []string{
	"abacate", "abacaxi", "abelha", "abobora", "acacia", "alecrim", "alface", "altura", "alvorada", "ametista",
	"amora", "ancora", "antigo", "areia", "arvore", "asfalto", "astro", "atomo", "avental", "azul",
	"bambu", "banana", "barco", "batata", "baunilha", "beijo", "bisonte", "brisa", "bronze", "cacto",
	"cadeira", "calor", "camelo", "caminho", "campina", "canela", "canyon", "capim", "carvalho", "castelo",
	"caverna", "cedro", "cenoura", "cereja", "claro", "cobalto", "colina", "cometa", "concha", "cobre",
	"coral", "cosmos", "cratera", "cristal", "crista", "deserto", "diamante", "doce", "dourado", "duna",
	"eco", "eclipse", "elo", "esmeralda", "espelho", "espinho", "espiral", "esquilo", "estacao", "esteira",
	"estrela", "falcao", "farol", "ferro", "floresta", "fogo", "folha", "fonte", "fossil", "framboesa",
	"frio", "fruta", "fumaca", "galaxia", "galho", "garoa", "gato", "girassol", "glacial", "globo",
	"granito", "graveto", "guarda", "harpa", "horizonte", "hortelao", "iogurte", "ilha", "jade", "jasmim",
	"jaspe", "jornada", "juba", "lago", "lagoa", "laranja", "luz", "limao", "linha", "lince",
	"lirio", "lontra", "lua", "lunar", "macieira", "madeira", "manga", "manto", "mapa", "mar",
	"marfim", "marmore", "mel", "melancia", "menta", "mergulho", "miragem", "mistura", "mochila", "moeda",
	"montanha", "morango", "musgo", "nebula", "neve", "ninho", "noite", "nova", "nuvem", "oasis",
	"oceano", "oliva", "onda", "palmeira", "pantano", "papel", "passaro", "pedra", "pena", "pepino",
	"perola", "pessego", "piano", "pinheiro", "pioneiro", "pipoca", "pirata", "planeta", "pluma", "poeira",
	"pomar", "ponte", "prata", "prisma", "quartzo", "radar", "raio", "raiz", "rampa", "raposa",
	"recife", "relogio", "rio", "rocha", "rosa", "rubi", "sabao", "safira", "salmao", "semente",
	"senda", "serra", "silencio", "sol", "sombra", "sopro", "tangerina", "teia", "terra", "tijolo",
	"tigre", "trilha", "trigo", "tundra", "turquesa", "vale", "veludo", "vento", "verde", "vereda",
	"viagem", "violeta", "vulcao", "xisto",
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
