// Client-side key derivation parameters. The password never leaves the member's device:
// master = Argon2id(password, salt); authKey = HKDF(master,'mwb-auth') is sent to the host,
// wrapKey = HKDF(master,'mwb-wrap') stays local and wraps the member's private chat key.
export const CLIENT_KDF = { memoryKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 } as const;
// Server-side hash of the received authKey (OWASP minimum Argon2id profile).
export const SERVER_KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1, hashLength: 32 } as const;

export const LIMITS = {
  username: { min: 3, max: 32 },
  displayName: { min: 1, max: 60 },
  password: { min: 10, max: 256 },
  message: 16000,
  e2eMessage: 48000,
  title: 160,
  description: 8000,
  note: 4000,
  maxLinks: 20,
  groupMembers: 500,
} as const;

export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
