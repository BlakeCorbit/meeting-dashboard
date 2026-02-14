#!/usr/bin/env node
/**
 * sync.js — Auto-detect new Granola meetings, extract action items from
 * AI panel content, merge into data.json, and push to GitHub.
 *
 * Runs on a schedule via Windows Task Scheduler.
 * No AI API needed — parses Granola's existing AI summaries.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.json");
const STATE_FILE = path.join(__dirname, ".sync-state.json");
const CACHE_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE, "AppData", "Roaming"),
  "Granola",
  "cache-v3.json"
);

// --- Helpers ---

function log(msg) {
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[${ts}] ${msg}`);
}

function loadGranolaState() {
  if (!fs.existsSync(CACHE_PATH)) {
    throw new Error("Granola cache not found at " + CACHE_PATH);
  }
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
  return JSON.parse(raw.cache).state;
}

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n");
}

function loadSyncState() {
  if (!fs.existsSync(STATE_FILE)) return { processedMeetings: [] };
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

function saveSyncState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function getAttendeeNames(doc) {
  const names = [];
  if (doc.people?.creator?.name) names.push(doc.people.creator.name);
  if (doc.people?.attendees) {
    for (const a of doc.people.attendees) {
      names.push(a.details?.person?.name?.fullName || a.email || "Unknown");
    }
  }
  return [...new Set(names)];
}

function nextId(items) {
  if (items.length === 0) return 1;
  return Math.max(...items.map((i) => i.id || 0)) + 1;
}

// --- Action Item Extraction ---
// Parses Granola's AI panel summaries for action items without needing an AI API.

function extractActionItems(panelText, meetingTitle, meetingDate, attendees) {
  const items = [];
  const lines = panelText.split("\n");

  let inActionSection = false;
  let currentOwner = null;

  // Patterns that indicate action item sections
  const sectionPatterns = [
    /^next\s*steps/i,
    /^action\s*items/i,
    /^follow[- ]?ups?/i,
    /^to[- ]?do/i,
    /^tasks?\s*:/i,
    /^deliverables/i,
  ];

  // Patterns that indicate end of action section
  const endPatterns = [
    /^chat with meeting transcript/i,
    /^#{1,3}\s/,
    /^[A-Z][a-z]+ [A-Z][a-z]+ &/,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if we're entering an action items section
    if (sectionPatterns.some((p) => p.test(line))) {
      inActionSection = true;
      continue;
    }

    // Check for inline "Next Steps" style headers
    if (endPatterns.some((p) => p.test(line)) && inActionSection) {
      inActionSection = false;
      continue;
    }

    // Look for owner patterns like "Blake:" or "Blake to"
    const ownerMatch = line.match(/^(\w+(?:\s\w+)?)\s*:/);
    if (ownerMatch && inActionSection) {
      currentOwner = ownerMatch[1];
      const rest = line.slice(ownerMatch[0].length).trim();
      if (rest) {
        items.push({
          item: rest,
          owner: currentOwner,
        });
      }
      continue;
    }

    // In action section, treat each line as an action item
    if (inActionSection && line.length > 10) {
      // Try to detect owner from the line
      let owner = "Blake"; // default
      for (const name of attendees) {
        const firstName = name.split(" ")[0];
        if (line.toLowerCase().includes(firstName.toLowerCase() + " to ") ||
            line.toLowerCase().includes(firstName.toLowerCase() + " will ") ||
            line.toLowerCase().startsWith(firstName.toLowerCase())) {
          owner = name;
          break;
        }
      }
      items.push({
        item: line.replace(/^[-*•]\s*/, ""),
        owner: currentOwner || owner,
      });
    }

    // Also catch standalone action-like patterns outside sections
    if (!inActionSection) {
      const actionPatterns = [
        /(?:Blake|Jacob|Brien|Cole|Cory|Ally|Jenna|Jennifer|Al)\s+(?:to|will|should|needs? to)\s+(.+)/i,
      ];
      for (const pattern of actionPatterns) {
        const match = line.match(pattern);
        if (match) {
          const ownerName = line.match(/^(\w+(?:\s\w+)?)\s+(?:to|will|should|needs? to)/i);
          items.push({
            item: match[0],
            owner: ownerName ? ownerName[1] : "Blake",
          });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return items.filter((item) => {
    const key = item.item.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Main ---

function run() {
  log("Starting sync...");

  let granolaState;
  try {
    granolaState = loadGranolaState();
  } catch (e) {
    log("ERROR: " + e.message);
    return;
  }

  const data = loadData();
  const syncState = loadSyncState();
  const processedSet = new Set(syncState.processedMeetings);

  const docs = granolaState.documents || {};
  const panels = granolaState.documentPanels || {};

  // Find new meetings with AI panel content
  const newMeetings = Object.entries(docs)
    .map(([id, doc]) => ({ id, ...doc }))
    .filter((m) => !m.deleted_at)
    .filter((m) => !processedSet.has(m.id))
    .filter((m) => panels[m.id] && Object.keys(panels[m.id]).length > 0)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (newMeetings.length === 0) {
    log("No new meetings to process.");
    return;
  }

  log(`Found ${newMeetings.length} new meeting(s) to process.`);

  let totalNewItems = 0;

  for (const meeting of newMeetings) {
    const meetingDate = new Date(meeting.created_at).toISOString().slice(0, 10);
    const attendees = getAttendeeNames(meeting);
    const title = meeting.title || "Untitled";

    log(`Processing: "${title}" (${meetingDate})`);

    // Get panel content
    const docPanels = panels[meeting.id];
    const panelText = Object.values(docPanels)
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((p) => {
        const t = p.title || "";
        const c = stripHtml(p.original_content || "");
        return t + ":\n" + c;
      })
      .join("\n\n");

    // Extract action items
    const extracted = extractActionItems(panelText, title, meetingDate, attendees);

    if (extracted.length > 0) {
      log(`  Extracted ${extracted.length} action item(s)`);
      for (const ai of extracted) {
        const newItem = {
          id: nextId(data.actionItems),
          item: ai.item,
          owner: ai.owner,
          dueDate: null,
          status: "open",
          meetingTitle: title,
          meetingDate: meetingDate,
          dateAdded: new Date().toISOString().slice(0, 10),
          completedDate: null,
          notes: "",
        };
        data.actionItems.push(newItem);
        totalNewItems++;
        log(`  + #${newItem.id}: ${ai.item.slice(0, 60)}...`);
      }
    } else {
      log(`  No action items found in panel content.`);
    }

    // Log the meeting
    if (!data.meetings.find((m) => m.title === title && m.date === meetingDate)) {
      data.meetings.push({
        title,
        date: meetingDate,
        participants: attendees,
        actionItemCount: extracted.length,
      });
    }

    // Mark as processed
    processedSet.add(meeting.id);
  }

  // Save
  syncState.processedMeetings = [...processedSet];
  saveSyncState(syncState);
  saveData(data);
  log(`Saved ${totalNewItems} new action item(s), ${newMeetings.length} meeting(s) logged.`);

  // Git push
  if (totalNewItems > 0 || newMeetings.length > 0) {
    try {
      execSync("git add data.json", { cwd: __dirname, stdio: "pipe" });
      execSync(
        `git commit -m "Auto-sync: ${newMeetings.length} meeting(s), ${totalNewItems} action item(s)"`,
        { cwd: __dirname, stdio: "pipe" }
      );
      execSync("git push", { cwd: __dirname, stdio: "pipe" });
      log("Pushed to GitHub. Dashboard will update shortly.");
    } catch (e) {
      // If nothing to commit, that's fine
      if (e.stderr && e.stderr.toString().includes("nothing to commit")) {
        log("No changes to commit.");
      } else {
        log("Git push failed: " + (e.stderr ? e.stderr.toString() : e.message));
      }
    }
  }

  log("Sync complete.");
}

run();
