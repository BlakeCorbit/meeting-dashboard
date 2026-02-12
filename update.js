#!/usr/bin/env node
/**
 * update.js — Push updated data.json to the meeting-dashboard repo.
 *
 * Usage (called by Claude after extracting action items):
 *   node update.js                           # commit & push current data.json
 *   node update.js --add '{"item":"...", "owner":"...", ...}'  # add an action item then push
 *   node update.js --complete 3              # mark action item #3 as completed then push
 *   node update.js --add-meeting '{"title":"...", ...}'        # log a processed meeting
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

function nextId(items) {
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.id || 0)) + 1;
}

function run(cmd) {
  execSync(cmd, { cwd: __dirname, stdio: "inherit" });
}

const args = process.argv.slice(2);
const data = loadData();

let i = 0;
while (i < args.length) {
  const flag = args[i];

  if (flag === "--add" && args[i + 1]) {
    const item = JSON.parse(args[i + 1]);
    item.id = nextId(data.actionItems);
    item.status = item.status || "open";
    item.dateAdded = item.dateAdded || new Date().toISOString().slice(0, 10);
    item.completedDate = null;
    item.notes = item.notes || "";
    data.actionItems.push(item);
    console.log(`Added action item #${item.id}: ${item.item}`);
    i += 2;
  } else if (flag === "--complete" && args[i + 1]) {
    const id = parseInt(args[i + 1]);
    const found = data.actionItems.find((a) => a.id === id);
    if (found) {
      found.status = "completed";
      found.completedDate = new Date().toISOString().slice(0, 10);
      console.log(`Completed action item #${id}: ${found.item}`);
    } else {
      console.error(`Action item #${id} not found`);
    }
    i += 2;
  } else if (flag === "--add-meeting" && args[i + 1]) {
    const meeting = JSON.parse(args[i + 1]);
    data.meetings.push(meeting);
    console.log(`Logged meeting: ${meeting.title}`);
    i += 2;
  } else {
    i++;
  }
}

saveData(data);

// Git commit & push
try {
  run("git add data.json");
  run('git commit -m "Update action items dashboard"');
  run("git push");
  console.log("Pushed to GitHub. Dashboard will update shortly.");
} catch (e) {
  console.error("Git push failed:", e.message);
}
