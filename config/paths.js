// config/paths.js
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const DATA_DIR = process.env.DATA_DIR || "/var/data/ig"; // set on Render

// ensure folder exists at boot
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const COOKIES_PATH_ = `${DATA_DIR}/ig.cookies.json`;
export const LEDGER_PATH_ = `${DATA_DIR}/ig.already_contacted.json`;