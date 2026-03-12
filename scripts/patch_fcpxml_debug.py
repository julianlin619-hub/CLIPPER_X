#!/usr/bin/env python3
"""
patch_fcpxml_debug.py — verbose trace of the FCPXML patch pipeline (asset-clip mode).

Mirrors patch_fcpxml.py exactly but prints every value, every decision,
and every attribute written. No output FCPXML is written.

Usage:
    python3 patch_fcpxml_debug.py <multicam.fcpxml> <kept_ranges_json>
"""

import sys, json, re
from fractions import Fraction
import xml.etree.ElementTree as ET

def parse_time(s):
    s = s.strip().rstrip("s")
    if "/" in s:
        n, d = s.split("/", 1)
        return Fraction(int(n), int(d))
    return Fraction(s)

def fmt_time(f):
    f = Fraction(f)
    return f"{f.numerator}/{f.denominator}s"

def snap(t, frame_dur):
    return round(t / frame_dur) * frame_dur

def fs(f):
    f = Fraction(f)
    return f"{f.numerator}/{f.denominator}s ({float(f):.6f}s)"

def get_frame_duration(root, sequence):
    fmt_id = sequence.get("format")
    for fmt in root.findall(".//format"):
        if fmt.get("id") == fmt_id:
            fd = fmt.get("frameDuration")
            if fd:
                return parse_time(fd)
    return Fraction(1001, 30000)

def clip_tl_range(clip):
    offset = parse_time(clip.get("offset", "0/1s"))
    dur    = parse_time(clip.get("duration", "0/1s"))
    return offset, offset + dur

def hr(char="─", width=80):
    print(char * width)

def section(title):
    print()
    print(f"── {title} " + "─" * max(0, 76 - len(title)))


def debug(multicam_path, kept_ranges):
    raw  = open(multicam_path, "r", encoding="utf-8").read()
    root = ET.fromstring(re.sub(r"<!DOCTYPE[^>]*>", "", raw))

    sequence = root.find(".//sequence")
    if sequence is None:
        print("ERROR: No <sequence> found"); return
    spine = sequence.find("spine")
    if spine is None:
        print("ERROR: No <spine> found"); return

    tc_start   = parse_time(sequence.get("tcStart", "0/1s"))
    frame_dur  = get_frame_duration(root, sequence)
    fps        = float(1 / frame_dur)
    orig_clips = [c for c in spine if c.tag == "clip"]

    hr("═")
    print("CLIPPER — FCPXML PATCH DEBUG LOG  (asset-clip mode)")
    hr("═")
    print(f"  Input FCPXML  : {multicam_path}")
    print(f"  Kept ranges   : {len(kept_ranges)}")
    for i, r in enumerate(kept_ranges, 1):
        print(f"    Range {i}: start={r['start']:.6f}s  end={r['end']:.6f}s  dur={r['end']-r['start']:.6f}s")

    section("SEQUENCE METADATA")
    print(f"  tcStart      : {sequence.get('tcStart')} ({float(tc_start):.6f}s)")
    print(f"  tcFormat     : {sequence.get('tcFormat','—')}")
    print(f"  format id    : {sequence.get('format','—')}")
    print(f"  frameDuration: {fmt_time(frame_dur)} ({float(frame_dur):.6f}s) ({fps:.4f} fps)")
    print(f"  duration     : {sequence.get('duration','—')}")

    section(f"ORIGINAL SPINE CLIPS ({len(orig_clips)})")
    for i, clip in enumerate(orig_clips, 1):
        cs, ce = clip_tl_range(clip)
        print(f"  Clip {i}: name={clip.get('name','—')}")
        print(f"    offset   : {clip.get('offset')} ({float(cs):.6f}s)  ← timeline position")
        print(f"    start    : {clip.get('start')} ({float(parse_time(clip.get('start','0/1s'))):.6f}s)  ← source in-point (camera tc)")
        print(f"    duration : {clip.get('duration')} ({float(parse_time(clip.get('duration','0/1s'))):.6f}s)")
        print(f"    tl range : [{float(cs):.6f}s, {float(ce):.6f}s]")
        for child in clip:
            tag  = child.tag
            lane = child.get("lane","(none)")
            ref  = child.get("ref","")
            cs2  = child.get("start")
            co   = child.get("offset")
            cd   = child.get("duration")
            print(f"    <{tag} lane={lane} ref={ref}>")
            if cs2: print(f"      start={child.get('start')} ({float(parse_time(cs2)):.6f}s)")
            if co:  print(f"      offset={child.get('offset')} ({float(parse_time(co)):.6f}s)")
            if cd:  print(f"      duration={child.get('duration')} ({float(parse_time(cd)):.6f}s)")
            if tag == "video":
                ok = cs2 and co and parse_time(cs2) == parse_time(co)
                print(f"      ⚑ anchor: offset==start: {'✅' if ok else '⚠️ MISMATCH'}")
            for gc in child:
                gt = gc.tag; gl = gc.get("lane","(none)"); gr = gc.get("ref","")
                gs = gc.get("start"); go = gc.get("offset"); gd = gc.get("duration")
                print(f"      <{gt} lane={gl} ref={gr}>")
                if gs: print(f"        start={gs} ({float(parse_time(gs)):.6f}s)")
                if go: print(f"        offset={go} ({float(parse_time(go)):.6f}s)")
                if gd: print(f"        duration={gd} ({float(parse_time(gd)):.6f}s)")
                if gt == "video":
                    ok = gs and go and parse_time(gs) == parse_time(go)
                    print(f"        ⚑ anchor: offset==start: {'✅' if ok else '⚠️ MISMATCH'}")

    hr("═")
    print("SEGMENT PROCESSING  (output: flat <asset-clip> per track, no compound wrapper)")
    hr("═")

    timeline_cur = tc_start
    output_clips = []

    for seg_i, seg in enumerate(kept_ranges, 1):
        section(f"SEGMENT {seg_i} of {len(kept_ranges)}")
        print(f"  MP4 range    : start={seg['start']:.6f}s  end={seg['end']:.6f}s  dur={seg['end']-seg['start']:.6f}s")
        print(f"  timeline_cur : {fmt_time(timeline_cur)} ({float(timeline_cur):.6f}s)")

        raw_ks = float(seg["start"]) + float(tc_start)
        raw_ke = float(seg["end"])   + float(tc_start)
        ks = snap(Fraction(seg["start"]) + tc_start, frame_dur)
        ke = snap(Fraction(seg["end"])   + tc_start, frame_dur)
        if ke <= ks:
            ke = ks + frame_dur

        print()
        print(f"  CALC raw_ks  : {seg['start']:.6f} + {float(tc_start):.6f} = {raw_ks:.6f}s")
        print(f"  CALC ks      : snap → {fs(ks)}")
        print(f"  CALC raw_ke  : {seg['end']:.6f} + {float(tc_start):.6f} = {raw_ke:.6f}s")
        print(f"  CALC ke      : snap → {fs(ke)}")

        overlapping = []
        print()
        print(f"  OVERLAP SEARCH [{float(ks):.6f}s, {float(ke):.6f}s]:")
        for clip in orig_clips:
            cs, ce = clip_tl_range(clip)
            os_ = max(ks, cs); oe = min(ke, ce)
            if oe > os_:
                print(f"    '{clip.get('name','')}' tl=[{float(cs):.6f}, {float(ce):.6f}]  overlap=[{float(os_):.6f}, {float(oe):.6f}] ✅")
                overlapping.append((clip, os_, oe))
            else:
                print(f"    '{clip.get('name','')}' tl=[{float(cs):.6f}, {float(ce):.6f}]  no overlap ✗")

        if not overlapping:
            print("  ⚠️  NO OVERLAP — segment skipped")
            continue
        print(f"  → {len(overlapping)} clip(s)")

        range_groups = {}; range_order = []
        for (clip, os_, oe) in overlapping:
            key = (os_, oe)
            range_groups.setdefault(key, []).append(clip)
            if key not in range_order:
                range_order.append(key)

        for (os_, oe) in range_order:
            out_offset = timeline_cur
            print()
            print(f"  ── Sub-range [{float(os_):.6f}s → {float(oe):.6f}s]  out_offset={fs(out_offset)}")

            for clip in range_groups[(os_, oe)]:
                clip_offset_val  = parse_time(clip.get("offset", "0/1s"))
                outer_orig_start = parse_time(clip.get("start", "0/1s"))
                raw_trim   = float(os_) - float(clip_offset_val)
                front_trim = snap(max(Fraction(0), os_ - clip_offset_val), frame_dur)
                new_dur_val = snap(oe - os_, frame_dur)
                if new_dur_val < frame_dur:
                    new_dur_val = frame_dur
                new_outer_start = outer_orig_start + front_trim

                print()
                print(f"  ┌── emit_as_asset_clips() ──────────────────────────────────────────")
                print(f"  │  clip           : {clip.get('name','')}")
                print(f"  │  clip.offset    : {fs(clip_offset_val)}")
                print(f"  │  clip.start     : {fs(outer_orig_start)}  ← camera tc")
                print(f"  │  clip.duration  : {fs(parse_time(clip.get('duration','0/1s')))}")
                print(f"  │")
                print(f"  │  CALC raw_trim  : seg_s - clip.offset = {float(os_):.6f} - {float(clip_offset_val):.6f} = {raw_trim:.6f}s")
                print(f"  │  CALC front_trim: snap(max(0,raw)) = {fs(front_trim)}")
                print(f"  │  CALC new_dur   : snap(seg_e-seg_s)  = {fs(new_dur_val)}")
                print(f"  │")
                print(f"  │  NOTE: compound <clip> start={float(outer_orig_start):.0f}s >> clip.duration={float(parse_time(clip.get('duration','0/1s'))):.0f}s")
                print(f"  │        FCP would clamp to frame 0 (no tcStart on compound clip).")
                print(f"  │        Using flat <asset-clip> instead — start= is always respected. ✅")
                print(f"  │")

                tracks = []

                # PRIMARY VIDEO
                pv = next((c for c in clip if c.tag == "video" and c.get("lane") is None), None)
                if pv is not None:
                    ref = pv.get("ref","")
                    asset_tc = parse_time(pv.get("offset","0/1s"))
                    into_file = float(new_outer_start) - float(asset_tc)
                    adj = clip.find("adjust-transform")
                    print(f"  │  ── PRIMARY <asset-clip ref={ref}> ────────────────────────────────")
                    print(f"  │    asset start tc  : {fs(asset_tc)}")
                    print(f"  │    WRITE start     : {float(outer_orig_start):.6f} + {float(front_trim):.6f} = {fs(new_outer_start)}")
                    print(f"  │    into asset file : start - asset_tc = {into_file:.6f}s")
                    print(f"  │    WRITE offset    : {fs(out_offset)}")
                    print(f"  │    WRITE duration  : {fs(new_dur_val)}")
                    print(f"  │    adjust-transform: {'copied ✅' if adj is not None else 'none'}")
                    tracks.append(("primary", ref, new_outer_start, new_dur_val))

                # LANE TRACKS
                for child in clip:
                    lane = child.get("lane")
                    if lane is None:
                        continue
                    if child.tag == "clip":
                        iv = child.find("video")
                        if iv is None: continue
                        ref = iv.get("ref","")
                        lane_orig = parse_time(child.get("start","0/1s"))
                        lane_new  = lane_orig + front_trim
                        lane_asset_tc = parse_time(iv.get("offset","0/1s"))
                        into_file = float(lane_new) - float(lane_asset_tc)
                        adj = child.find("adjust-transform")
                        print(f"  │")
                        print(f"  │  ── LANE {lane} <asset-clip ref={ref}> (camera) ───────────────────────")
                        print(f"  │    lane orig start : {fs(lane_orig)}")
                        print(f"  │    asset start tc  : {fs(lane_asset_tc)}")
                        print(f"  │    WRITE start     : {float(lane_orig):.6f} + {float(front_trim):.6f} = {fs(lane_new)}")
                        print(f"  │    into asset file : start - asset_tc = {into_file:.6f}s")
                        print(f"  │    WRITE offset    : {fs(out_offset)}  (same as primary — in sync)")
                        print(f"  │    WRITE duration  : {fs(new_dur_val)}")
                        print(f"  │    adjust-transform: {'copied ✅' if adj is not None else 'none'}")
                        tracks.append((f"lane_{lane}_cam", ref, lane_new, new_dur_val))
                    elif child.tag == "asset-clip":
                        ref = child.get("ref","")
                        co  = parse_time(child.get("start","0/1s"))
                        cn  = co + front_trim
                        print(f"  │")
                        print(f"  │  ── LANE {lane} <asset-clip ref={ref}> ({child.get('name','')}) ──────────────")
                        print(f"  │    orig start      : {fs(co)}")
                        print(f"  │    WRITE start     : {float(co):.6f} + {float(front_trim):.6f} = {fs(cn)}")
                        print(f"  │    WRITE offset    : {fs(out_offset)}  (same as primary — in sync)")
                        print(f"  │    WRITE duration  : {fs(new_dur_val)}")
                        tracks.append((f"lane_{lane}_asset", ref, cn, new_dur_val))

                print(f"  │")
                print(f"  │  SYNC CHECK — all {len(tracks)} track(s) at offset={float(out_offset):.6f}s:")
                for (tname, ref, s, d) in tracks:
                    print(f"  │    {tname:25s}  ref={ref:4s}  start={float(s):.6f}s  dur={float(d):.6f}s")
                print(f"  └──────────────────────────────────────────────────────────────────")
                output_clips.append({"seg": seg_i, "out_offset": out_offset,
                                     "new_start": new_outer_start, "new_dur": new_dur_val, "tracks": tracks})

            timeline_cur += (oe - os_)
            print()
            print(f"  timeline_cur → {fs(timeline_cur)}")

    hr("═")
    print("SUMMARY")
    hr("═")
    print(f"  Input kept ranges     : {len(kept_ranges)}")
    print(f"  Output primary clips  : {len(output_clips)}")
    print(f"  Total output duration : {sum(float(c['new_dur']) for c in output_clips):.6f}s")
    print(f"  Output format         : flat <asset-clip> elements (no compound wrapper)")
    print()
    print(f"  {'#':<4} {'out_offset':>14}  {'start (camera tc)':>20}  {'dur':>10}  tracks")
    print(f"  {'─'*4} {'─'*14}  {'─'*20}  {'─'*10}  {'─'*30}")
    for i, c in enumerate(output_clips, 1):
        tstr = " | ".join(f"{t[0]}({t[1]})" for t in c["tracks"])
        print(f"  {i:<4} {float(c['out_offset']):>14.6f}  {float(c['new_start']):>20.6f}  {float(c['new_dur']):>10.6f}  {tstr}")
    print()
    print("END OF DEBUG LOG")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: patch_fcpxml_debug.py <multicam.fcpxml> <kept_ranges_json>")
        sys.exit(1)
    try:
        kept_ranges = json.loads(sys.argv[2])
        debug(sys.argv[1], kept_ranges)
    except Exception as e:
        import traceback
        print(f"ERROR: {e}\n{traceback.format_exc()}")
        sys.exit(1)
