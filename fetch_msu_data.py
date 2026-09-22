"""
Spartan Analytics Hub — data pipeline (v2)
Pulls MSU's 2026 data from the College Football Data API and writes
data/msu_2026.json in the EXACT shape spartan-analytics.html expects, so
dropping this file next to the page on GitHub Pages makes it live with
no front-end changes.

Setup:
    pip install cfbd
    export CFBD_API_KEY="your_key"   # free at collegefootballdata.com/key
    python fetch_msu_data.py

NOTE: CFBD's exact field names shift between API versions. This script
was written against the commonly-used v4/v5 field names below — before
you trust the output, run once, open data/msu_2026.json, and eyeball it
against a game you watched. Field names marked with a comment are the
ones most likely to need a tweak.
"""

import os
import json
import datetime
import cfbd

TEAM = "Michigan State"
YEAR = 2026
OUT_PATH = "data/msu_2026.json"

config = cfbd.Configuration(access_token=os.environ["CFBD_API_KEY"])
api_client = cfbd.ApiClient(config)
games_api = cfbd.GamesApi(api_client)
plays_api = cfbd.PlaysApi(api_client)
metrics_api = cfbd.MetricsApi(api_client)


# ---------- Success Matrix ----------

def success_target(down, distance):
    if down == 1:
        return 0.5
    if down == 2:
        return 0.5 if distance >= 4 else 0.6
    return 1.0  # 3rd/4th down


def bucket_for(down, distance):
    if down == 1 and distance >= 7:
        return "1st & 10"
    if down == 2 and 4 <= distance <= 6:
        return "2nd & Medium"
    if down in (3, 4) and 1 <= distance <= 3:
        return "3rd & Short"
    if down in (3, 4) and distance >= 7:
        return "3rd & Long"
    return None


def build_matrix(plays):
    sub = {"1st & 10": "Standard down", "2nd & Medium": "4\u20136 yds to go",
           "3rd & Short": "1\u20133 yds to go", "3rd & Long": "7+ yds to go"}
    agg = {}
    for p in plays:
        down = p.down          # CFBD Play field
        distance = p.distance  # CFBD Play field
        b = bucket_for(down, distance)
        if not b:
            continue
        gained = p.yards_gained or 0
        success = gained >= success_target(down, distance) * distance
        row = agg.setdefault(b, {"plays": 0, "successes": 0, "epa_sum": 0.0})
        row["plays"] += 1
        row["successes"] += int(success)
        row["epa_sum"] += getattr(p, "ppa", 0) or 0  # CFBD calls it "ppa" (predicted points added)
    out = []
    for b, row in agg.items():
        out.append({
            "bucket": b, "sub": sub.get(b, ""),
            "plays": row["plays"],
            "rate": round(row["successes"] / row["plays"], 3) if row["plays"] else 0,
            "epa": round(row["epa_sum"] / row["plays"], 2) if row["plays"] else 0,
        })
    return out


# ---------- Special Teams ----------

def build_special_teams(completed_games, plays_by_game):
    punts, field_pos = [], []
    for g, plays in plays_by_game:
        tag = g.away_team[:3].upper() if g.home_team == TEAM else g.home_team[:3].upper()
        punt_plays = [p for p in plays if getattr(p, "play_type", "") == "Punt"]
        net_yards = [p.yards_gained for p in punt_plays if p.yards_gained is not None]
        punts.append({"opp": tag, "net": round(sum(net_yards) / len(net_yards), 1) if net_yards else None})

        # Placeholder — CFBD's drive-start yard line lives on the Drives
        # endpoint (drives_api.get_drives), not on individual plays. Swap
        # this block to pull from there for real starting field position.
        field_pos.append({"opp": tag, "msu": None, "vs": None})
    return {"punts": punts, "field_position": field_pos}


# ---------- Win probability + swings ----------

def build_game_entry(g):
    tag = g.away_team[:3].upper() if g.home_team == TEAM else g.home_team[:3].upper()
    is_home = g.home_team == TEAM
    msu_points = g.home_points if is_home else g.away_points
    opp_points = g.away_points if is_home else g.home_points
    result = "W" if (msu_points or 0) > (opp_points or 0) else "L"
    score = f"{msu_points}-{opp_points}"

    wp_raw = metrics_api.get_win_probability(game_id=g.id)
    print(wp_raw[0])
    # Resample CFBD's per-play win prob down to 61 points (minute 0-60) so
    # it lines up with the front end's fixed-length array.
    wp61 = [None] * 61
    if wp_raw:
        for w in wp_raw:
            seconds_left = getattr(w, "seconds_remaining_in_game", 3600) or 3600
            minute = 60 - min(60, max(0, int(seconds_left // 60)))
            prob = w.home_win_probability if is_home else (1 - w.home_win_probability)
            wp61[minute] = round(prob * 100, 1)
        # forward-fill any minutes with no play recorded
        last = 50.0
        for i in range(61):
            if wp61[i] is None:
                wp61[i] = last
            else:
                last = wp61[i]
    else:
        wp61 = [50.0] * 61

    swings = []
    if wp_raw:
        deltas = []
        prev = None
        for w in wp_raw:
            prob = (w.home_win_probability if is_home else (1 - w.home_win_probability)) * 100
            if prev is not None:
                deltas.append((prob - prev, w))
            prev = prob
        deltas.sort(key=lambda d: abs(d[0]), reverse=True)
        for delta, w in deltas[:4]:
            swings.append({
                "time": f"Q{getattr(w, 'period', '?')} {getattr(w, 'clock', '')}",
                "desc": getattr(w, "play_text", "Key play"),
                "wpa": round(delta, 1),
            })

    return {"opp": g.away_team if is_home else g.home_team, "tag": tag,
            "result": result, "score": score, "wp": wp61, "swings": swings}


    def main():
        
        season_games = games_api.get_games(year=YEAR, team=TEAM)
        completed = [g for g in season_games if g.completed]
        
        plays_by_game = []
        all_plays = []
        for g in completed:
        try:
            plays = plays_api.get_plays(year=YEAR, week=g.week, team=TEAM)
        except Exception as e:
            print(f"Skipping week {g.week}: {e}")
            plays = []
        plays_by_game.append((g, plays))
        all_plays += plays
        
    wins = sum(
    1 for g in completed
    if (g.home_points if g.home_team == TEAM else g.away_points) >
    (g.away_points if g.home_team == TEAM else g.home_points)
    )
    losses = len(completed) - wins
    win_pct = round(wins / len(completed), 3) if completed else 0.0
        
    key_players = []
        try:
        player_stats_data = games_api.get_game_player_stats(year=YEAR, team=TEAM)
        key_players = player_stats_data
        except Exception as e:
        print(f"Could not fetch player stats: {e}")
        
    payload = {
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "record": {
        "wins": wins,
        "losses": losses,
        "win_percentage": win_pct
        },
        "schedule": [
            {
                "week": g.week,
                "season_type": g.season_type,
                "start_date": g.start_date,
                "home_team": g.home_team,
                "away_team": g.away_team,
                "home_points": g.home_points,
                "away_points": g.away_points,
                "completed": g.completed,
            }
            for g in season_games
        ],
        "key_players": key_players,
        "matrix": {"all": build_matrix(all_plays)},
        "special_teams": build_special_teams(completed, plays_by_game),
        "games": [build_game_entry(g) for g in completed],
        }
        
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)
        
        print(f"Wrote {OUT_PATH} \U002014 Full schedule and stats updated.")
        
    if __name__ == "__main__":
        main()

