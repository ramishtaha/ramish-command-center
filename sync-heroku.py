#!/usr/bin/env python3
"""
Hermes ↔ Command Center Sync Script
Bidirectional sync between local markdown trackers and the Heroku web app.

Usage:
  python3 sync-heroku.py push   # Push local tracker state → Heroku
  python3 sync-heroku.py pull    # Pull Heroku state → local trackers
  python3 sync-heroku.py status  # Show sync status (no changes)

Runs automatically via cron or on-demand from Hermes session.
"""

import json
import os
import re
import sys
from datetime import datetime, date
import urllib.request
import urllib.error

# ─── Config ───
HEROKU_URL = "https://ramish-command-center-f4bee27fd546.herokuapp.com"
API_KEY = os.environ.get("COMMAND_CENTER_API_KEY", "hermes-sync-ramish-2026")
TRACKER_DIR = "/root/career-switch-plan/tracker"
SESSION_STATE = "/root/career-switch-plan/session-state.md"
DSA_TRACKER = f"{TRACKER_DIR}/dsa-tracker.md"
PROGRESS_TRACKER = f"{TRACKER_DIR}/progress.md"

# ─── HTTP helpers ───

def api_get(path):
    url = f"{HEROKU_URL}{path}"
    req = urllib.request.Request(url, headers={"x-api-key": API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"❌ GET {path} → {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        print(f"❌ GET {path} → {e}")
        return None

def api_post(path, data):
    url = f"{HEROKU_URL}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={
        "x-api-key": API_KEY,
        "Content-Type": "application/json"
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"❌ POST {path} → {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        print(f"❌ POST {path} → {e}")
        return None

# ─── Markdown parsers ───

def parse_session_state():
    """Extract key fields from session-state.md"""
    with open(SESSION_STATE, "r") as f:
        content = f.read()
    
    def extract(pattern):
        m = re.search(pattern, content, re.IGNORECASE)
        return m.group(1).strip() if m else None
    
    active_days = extract(r"Active Day Count.*?(\d+)")
    dsa_solved = extract(r"DSA Problems Solved.*?(\d+)")
    dsa_unaided = extract(r"DSA Unaided.*?(\d+)/\d+")
    current_streak = extract(r"Current Streak.*?(\d+)")
    longest_streak = extract(r"Longest Streak.*?(\d+)")
    last_bar = extract(r"Last Bar Hit.*?—\s*(\S+)")
    claude_cert = extract(r"Claude Cert Progress.*?—\s*(.+)")
    
    return {
        "active_day_count": int(active_days or 0),
        "dsa_total": int(dsa_solved or 0),
        "dsa_unaided_count": int(dsa_unaided or 0),
        "current_streak": int(current_streak or 0),
        "longest_streak": int(longest_streak or 0),
        "bar_hit_today": last_bar or "none",
        "claude_cert_minutes": 0,
        "active_day": True,
        "mode_used": "home",
        "office_time_used": False,
    }

def parse_dsa_tracker():
    """Extract solved problems from dsa-tracker.md"""
    with open(DSA_TRACKER, "r") as f:
        lines = f.readlines()
    
    problems = []
    in_solved = False
    for line in lines:
        if "## Solved Problems" in line:
            in_solved = True
            continue
        if in_solved and line.startswith("## "):
            break
        if in_solved and line.startswith("|"):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 10 and "Problem" not in parts[1] and "---" not in parts[1]:
                name = parts[2]
                pattern = parts[3]
                difficulty = parts[4]
                date_str = parts[5]
                help_text = parts[7] if len(parts) > 7 else ""
                
                help_level = "alone"
                if "copilot" in help_text.lower():
                    help_level = "copilot"
                elif "hint" in help_text.lower() or "yes" in help_text.lower():
                    help_level = "hint"
                
                # Parse date
                try:
                    parsed_date = datetime.strptime(date_str, "%Y-%m-%d").strftime("%Y-%m-%d")
                except:
                    parsed_date = date.today().isoformat()
                
                problems.append({
                    "problem_name": name,
                    "pattern": pattern,
                    "difficulty": difficulty.lower(),
                    "help_level": help_level,
                    "date": parsed_date,
                    "notes": "",
                })
    
    return problems

def parse_overdue_revisions():
    """Extract overdue revisions from dsa-tracker.md"""
    with open(DSA_TRACKER, "r") as f:
        content = f.read()
    
    overdue = []
    lines = content.split("\n")
    for line in lines:
        if "🔴 OVERDUE" in line and "|" in line:
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 8 and "Problem" not in parts[1]:
                problem = parts[1]
                solved_date = parts[2]
                try:
                    solved_dt = datetime.strptime(solved_date, "%b %d")
                    days_overdue = (date.today() - solved_dt.date().replace(year=2026)).days
                except:
                    days_overdue = 1
                overdue.append({
                    "problem": problem,
                    "solved_date": solved_date,
                    "days_overdue": max(1, days_overdue),
                })
    
    return overdue

def parse_unaided_queue():
    """Extract unaided re-solve queue from dsa-tracker.md"""
    with open(DSA_TRACKER, "r") as f:
        content = f.read()
    
    queue = []
    in_queue = False
    for line in content.split("\n"):
        if "Unaided Re-solve Queue" in line:
            in_queue = True
            continue
        if in_queue and line.startswith("---"):
            break
        if in_queue and "⬜" in line:
            # Extract problem name
            m = re.search(r"⬜\s+(.+?)\s*\(", line)
            if m:
                help_level = "copilot" if "Copilot" in line else "hint"
                queue.append({
                    "problem": m.group(1).strip(),
                    "help_level": help_level,
                })
    
    return queue

def parse_today_plan():
    """Extract today's plan from progress.md (current week/day grid)"""
    with open(PROGRESS_TRACKER, "r") as f:
        content = f.read()
    
    # Find current week based on active day count
    state = parse_session_state()
    active_day = state["active_day_count"]
    
    # Parse the week grids to find what's planned for the current day
    # This is simplified — just extract the current week's tasks
    today_plan = {
        "dsa": [],
        "spring_boot": "",
        "system_design": "",
        "career": "",
        "devops": "",
    }
    
    # Look for the week that contains the current day
    week_pattern = re.compile(r"WEEK (\d+).*?Day \| Date \| DSA \| (Spring Boot|Spring Boot.*?System Design).*?\n(\|.*?\n)+", re.DOTALL)
    
    # Simpler: find the row matching current active day
    lines = content.split("\n")
    for i, line in enumerate(lines):
        if f"| {active_day} |" in line and "|" in line:
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 8:
                # Parse based on which week we're in
                today_plan["dsa"] = [p.strip() for p in parts[4].split(",") if p.strip()] if len(parts) > 4 else []
                today_plan["spring_boot"] = parts[5] if len(parts) > 5 else ""
                if len(parts) > 6:
                    today_plan["system_design"] = parts[6]
                if len(parts) > 7:
                    today_plan["devops"] = parts[7]
                if len(parts) > 8:
                    today_plan["career"] = parts[8]
            break
    
    return today_plan

# ─── Push: local → Heroku ───

def push_to_heroku():
    print("📤 Pushing local tracker state to Heroku...")
    
    state = parse_session_state()
    dsa_problems = parse_dsa_tracker()
    overdue = parse_overdue_revisions()
    unaided_queue = parse_unaided_queue()
    today_plan = parse_today_plan()
    
    payload = {
        "dsa_problems": dsa_problems,
        "state": state,
        "overdue_revisions": overdue,
        "unaided_queue": unaided_queue,
        "today_plan": today_plan,
        "replace_dsa": True,  # NEW: tell server to delete old DSA before inserting
    }
    
    result = api_post("/api/sync/bulk", payload)
    if result and result.get("success"):
        print(f"✅ Pushed: {len(dsa_problems)} DSA problems, streak {state['current_streak']}🔥, bar {state['bar_hit_today']}")
        print(f"   Overdue revisions: {len(overdue)} | Unaided queue: {len(unaided_queue)}")
    else:
        print("❌ Push failed")
    
    return result

# ─── Pull: Heroku → local ───

def pull_from_heroku():
    print("📥 Pulling Heroku state to local trackers...")
    
    data = api_get("/api/state")
    if not data:
        print("❌ Pull failed")
        return None
    
    # Show what we got
    progress = data.get("progress", [])
    dsa_log = data.get("dsa_log", [])
    journal = data.get("journal", [])
    reviews = data.get("reviews", [])
    app_state = data.get("app_state", {})
    
    print(f"✅ Pulled: {len(progress)} days of progress, {len(dsa_log)} DSA problems, {len(journal)} journal entries, {len(reviews)} reviews")
    
    # Compute stats
    if dsa_log:
        alone = sum(1 for p in dsa_log if p.get("help_level") == "alone")
        hint = sum(1 for p in dsa_log if p.get("help_level") == "hint")
        copilot = sum(1 for p in dsa_log if p.get("help_level") == "copilot")
        total = len(dsa_log)
        unaided_pct = round((alone / total) * 100) if total > 0 else 0
        print(f"   DSA unaided: 🟢{alone} 🟡{hint} 🟠{copilot} = {unaided_pct}% unaided")
    
    if progress:
        active_days = sum(1 for p in progress if p.get("active_day"))
        dsa_days = sum(1 for p in progress if p.get("dsa_done"))
        print(f"   Active days: {active_days} | DSA days: {dsa_days}")
    
    return data

# ─── Status: show without changing ───

def show_status():
    print("📊 Sync Status\n")
    
    # Local state
    state = parse_session_state()
    dsa = parse_dsa_tracker()
    overdue = parse_overdue_revisions()
    unaided = parse_unaided_queue()
    
    print(f"LOCAL (markdown trackers):")
    print(f"   Active days: {state['active_day_count']}/84")
    print(f"   DSA solved: {state['dsa_total']} (unaided: {state['dsa_unaided_count']})")
    print(f"   Streak: {state['current_streak']}🔥 (longest: {state['longest_streak']}🔥)")
    print(f"   Last bar: {state['bar_hit_today']}")
    print(f"   Overdue revisions: {len(overdue)}")
    print(f"   Unaided queue: {len(unaided)}")
    print()
    
    # Remote state
    data = api_get("/api/state")
    if data:
        progress = data.get("progress", [])
        dsa_log = data.get("dsa_log", [])
        print(f"REMOTE (Heroku app):")
        print(f"   Progress days: {len(progress)}")
        print(f"   DSA logged: {len(dsa_log)}")
        if dsa_log:
            alone = sum(1 for p in dsa_log if p.get("help_level") == "alone")
            print(f"   Unaided: {alone}/{len(dsa_log)} ({round(alone/len(dsa_log)*100)}%)")
    else:
        print(f"REMOTE (Heroku app): unreachable")
    
    print("\n💡 Run 'push' to sync local→Heroku, 'pull' to sync Heroku→local")

# ─── Main ───

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 sync-heroku.py [push|pull|status]")
        sys.exit(1)
    
    cmd = sys.argv[1].lower()
    if cmd == "push":
        push_to_heroku()
    elif cmd == "pull":
        pull_from_heroku()
    elif cmd == "status":
        show_status()
    else:
        print(f"Unknown command: {cmd}")
        print("Usage: python3 sync-heroku.py [push|pull|status]")
        sys.exit(1)
