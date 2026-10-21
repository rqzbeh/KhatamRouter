import path from "node:path";
import fs from "node:fs";
import { getDataDir } from "@/lib/dataDir.js";

export let DATA_DIR = getDataDir();
export let DB_DIR = path.join(DATA_DIR, "db");
export let DATA_FILE = path.join(DB_DIR, "data.sqlite");
export let BACKUPS_DIR = path.join(DB_DIR, "backups");
export let LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};

export function refreshPaths() {
  DATA_DIR = getDataDir();
  DB_DIR = path.join(DATA_DIR, "db");
  DATA_FILE = path.join(DB_DIR, "data.sqlite");
  BACKUPS_DIR = path.join(DB_DIR, "backups");
  LEGACY_FILES = {
    main: path.join(DATA_DIR, "db.json"),
    usage: path.join(DATA_DIR, "usage.json"),
    disabled: path.join(DATA_DIR, "disabledModels.json"),
    details: path.join(DATA_DIR, "request-details.json"),
  };
}

export function ensureDirs() {
  refreshPaths();
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
