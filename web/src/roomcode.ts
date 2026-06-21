// Client-side room code generation (SPEC §4.1).
//
// The host generates the 3-word room code in the browser so it can be shown
// instantly and used as the shared rendezvous key across both signaling
// transports (third-party Trystero/Nostr and the Go fallback — SPEC §3.1).
//
// This word list and generation MUST stay in sync with the server's
// `server/room.go` (`wordList` + `GenerateRoomCode`) so a host-chosen code is
// valid when the host falls back to the Go server.

// 160 Portuguese ASCII-only lowercase words (SPEC §11.3, resolved 2026-06-20).
export const WORD_LIST: readonly string[] = [
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
];

/**
 * Generate a three-word room code joined by hyphens (e.g. "tigre-rio-veludo"),
 * using cryptographically strong randomness. Mirrors server `GenerateRoomCode`.
 */
export function generateRoomCode(): string {
  const n = WORD_LIST.length;
  const rand = new Uint32Array(3);
  crypto.getRandomValues(rand);
  const words = [0, 1, 2].map((i) => WORD_LIST[rand[i] % n]);
  return words.join("-");
}

/**
 * Validate that a string looks like a room code: three lowercase words from the
 * known list joined by hyphens. Used to sanity-check user/QR input.
 */
export function isValidRoomCode(code: string): boolean {
  const parts = code.trim().toLowerCase().split("-");
  return parts.length === 3 && parts.every((p) => WORD_LIST.includes(p));
}
