// Standalone detached updater process (Neutralized for KhatamRouter).
// In-place npm package updates are permanently disabled for supply-chain security.

console.error("[updater] In-place package updates are permanently disabled in KhatamRouter.");
console.error("[updater] Please update via Docker or git pull.");
process.exit(1);
