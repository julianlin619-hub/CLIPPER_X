#!/usr/bin/env python3
"""
patch_fcpxml.py

Accepts a multicam FCPXML and a versions JSON array (one array of kept-clip
ranges per version).  For each version the original timeline is cloned and
shifted to a new position in the sequence; the kept clips are overlaid on
that copy as a connected-clip lane.

If only one version is supplied the behaviour is identical to the old
single-version mode (no timeline duplication).

Usage:
    python3 patch_fcpxml.py <input.fcpxml> <versions_json> <output.fcpxml> [video_path]

versions_json formats accepted:
    [[{start,end}, ...], [{start,end}, ...], ...]   ← new multi-version format
    [{start,end}, ...]                               ← legacy single-version format
"""

import sys, json, os, re
from fractions import Fraction
from copy import deepcopy
import xml.etree.ElementTree as ET

def log(obj):
    print(json.dumps(obj), flush=True)

def parse_time(s):
    if not s:
        return Fraction(0)
    s = s.strip().rstrip("s")
    if "/" in s:
        n, d = s.split("/", 1)
        return Fraction(int(n), int(d))
    return Fraction(s)

def fmt_time(f):
    f = Fraction(f)
    return f"{f.numerator}/{f.denominator}s"

def snap(t, fd):
    return round(t / fd) * fd

def get_frame_dur(root, sequence):
    fmt_id = sequence.get("format", "")
    for el in root.findall(".//format"):
        if el.get("id") == fmt_id and el.get("frameDuration"):
            return parse_time(el.get("frameDuration"))
    return Fraction(1001, 30000)

def indent(elem, level=0):
    pad = "\n" + "  " * level
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = pad + "  "
        if not elem.tail or not elem.tail.strip():
            elem.tail = pad
        for child in elem:
            indent(child, level + 1)
        if not child.tail or not child.tail.strip():
            child.tail = pad
    else:
        if level and (not elem.tail or not elem.tail.strip()):
            elem.tail = pad


def split_primary_clip(clip, cut_positions, overlay_list):
    """
    Split a primary spine clip at the given source-TC cut positions.

    cut_positions : collection of Fraction values in the clip's source-TC
                    coordinate space (same space as clip.start / lane
                    child offsets).
    overlay_list  : overlay clip elements (already trimmed + lane-set) to
                    distribute into the resulting segments.

    Splitting rules
    ───────────────
    • The primary clip's offset (timeline position) advances proportionally
      with each segment's start.
    • Each original lane child is trimmed to the intersection of its own
      range with each segment's range.  offset/start/duration are all
      adjusted; inner sub-elements (video, audio, adjust-*) are kept as-is.
    • Each overlay clip is attached to the one segment whose range fully
      contains it (overlays begin/end exactly at cut points, so this is
      always unambiguous).

    Returns a list of new <clip> elements to replace the original in the spine.
    """
    P_offset = parse_time(clip.get("offset", "0/1s"))   # timeline position
    P_start  = parse_time(clip.get("start",  "0/1s"))   # source in-point
    P_dur    = parse_time(clip.get("duration", "0/1s"))
    P_end    = P_start + P_dur

    inner_cuts = sorted(cp for cp in cut_positions if P_start < cp < P_end)
    boundaries = [P_start] + inner_cuts + [P_end]

    # Separate structural (non-lane) children from lane children
    non_lane_ch = [c for c in clip if c.get("lane") is None]
    lane_ch     = [c for c in clip if c.get("lane") is not None]

    result = []
    for i in range(len(boundaries) - 1):
        seg_s   = boundaries[i]
        seg_e   = boundaries[i + 1]
        seg_dur = seg_e - seg_s

        # New primary clip element for this segment
        new_clip = ET.Element(clip.tag)
        for k, v in clip.attrib.items():
            new_clip.set(k, v)
        new_clip.set("offset",   fmt_time(P_offset + (seg_s - P_start)))
        new_clip.set("start",    fmt_time(seg_s))
        new_clip.set("duration", fmt_time(seg_dur))

        # Structural children (adjust-conform, adjust-transform, video, audio)
        # are copied verbatim — they reference the full asset range and the
        # outer clip's start/duration do the trimming.
        for child in non_lane_ch:
            new_clip.append(deepcopy(child))

        # Original lane children: trim each to the intersection with this segment.
        for lc in lane_ch:
            lc_off = parse_time(lc.get("offset", "0/1s"))
            lc_dur = parse_time(lc.get("duration", "0/1s"))
            lc_src = parse_time(lc.get("start",   "0/1s"))
            lc_end = lc_off + lc_dur

            inter_s = max(lc_off, seg_s)
            inter_e = min(lc_end, seg_e)
            if inter_e <= inter_s:
                continue

            new_lc = deepcopy(lc)
            advance = inter_s - lc_off
            new_lc.set("offset",   fmt_time(inter_s))
            new_lc.set("start",    fmt_time(lc_src + advance))
            new_lc.set("duration", fmt_time(inter_e - inter_s))
            new_clip.append(new_lc)

        # Overlay clips whose range is fully contained in this segment.
        # Because cut points are exactly the overlay in/out points, each
        # overlay belongs to exactly one segment.
        for ov in overlay_list:
            ov_off = parse_time(ov.get("offset", "0/1s"))
            ov_dur = parse_time(ov.get("duration", "0/1s"))
            if ov_off >= seg_s and ov_off + ov_dur <= seg_e:
                new_clip.append(ov)

        result.append(new_clip)

    return result


def build_version_spine(outer_clips_orig, clips, tc_start, frame_dur, ref_lane, timeline_offset):
    """
    Build spine elements for one version, shifted by timeline_offset in the sequence.

    outer_clips_orig : the original (unmodified) outer spine clips, used for
                       source-clip lookup and as the base for deep-copies.
    clips            : list of {start, end} dicts (Deepgram source seconds).
    tc_start         : sequence tcStart as Fraction.
    frame_dur        : frame duration as Fraction.
    ref_lane         : lane number for the overlay track.
    timeline_offset  : Fraction to add to every spine clip's sequence offset.
    """
    if not clips:
        # No overlay for this version — shift copies of originals
        result = []
        for oc in outer_clips_orig:
            c = deepcopy(oc)
            c.set("offset", fmt_time(parse_time(c.get("offset", "0/1s")) + timeline_offset))
            result.append(c)
        return result

    # ── Step 1: Build overlay copies (against originals for position lookup) ──
    overlay_pairs = []
    for idx, seg in enumerate(clips):
        ks = snap(Fraction(seg["start"]), frame_dur)
        ke = snap(Fraction(seg["end"]),   frame_dur)
        if ke <= ks:
            ke = ks + frame_dur

        seg_dur       = ke - ks
        seg_seq_start = tc_start + ks

        source_clip = None
        for oc in outer_clips_orig:
            clip_offset  = parse_time(oc.get("offset", "0/1s"))
            clip_end_seq = clip_offset + parse_time(oc.get("duration"))
            if clip_offset <= seg_seq_start < clip_end_seq:
                source_clip = oc
                break
        if source_clip is None:
            source_clip = outer_clips_orig[0]

        clip_offset    = parse_time(source_clip.get("offset", "0/1s"))
        clip_src_start = parse_time(source_clip.get("start",  "0/1s"))
        advance        = seg_seq_start - clip_offset
        new_src_start  = clip_src_start + advance

        copy = deepcopy(source_clip)
        copy.set("lane",     str(ref_lane))
        copy.set("offset",   fmt_time(new_src_start))
        copy.set("start",    fmt_time(new_src_start))
        copy.set("duration", fmt_time(seg_dur))
        for child in list(copy):
            if child.get("lane") is not None:
                copy.remove(child)

        overlay_pairs.append((source_clip, copy))
        log({"status": "overlay_clip", "version_offset": float(timeline_offset),
             "idx": idx, "src_start": float(new_src_start), "dur": float(seg_dur)})

    # ── Step 2: Collect cut positions per primary clip ────────────────────────
    cuts_by_clip = {}
    for src, ov in overlay_pairs:
        sid = id(src)
        if sid not in cuts_by_clip:
            cuts_by_clip[sid] = set()
        ov_start = parse_time(ov.get("start"))
        ov_dur   = parse_time(ov.get("duration"))
        cuts_by_clip[sid].add(ov_start)
        cuts_by_clip[sid].add(ov_start + ov_dur)

    # ── Step 3: Split primary clips, shift timeline offset, collect ───────────
    new_spine = []
    for oc in outer_clips_orig:
        clip_overlays = [ov for src, ov in overlay_pairs if src is oc]
        cut_positions = cuts_by_clip.get(id(oc), set())
        splits = split_primary_clip(oc, cut_positions, clip_overlays)
        for s in splits:
            s.set("offset", fmt_time(parse_time(s.get("offset", "0/1s")) + timeline_offset))
        new_spine.extend(splits)

    return new_spine


if __name__ == "__main__":
    if len(sys.argv) < 4:
        log({"error": "Usage: patch_fcpxml.py <input.fcpxml> <versions_json> <output.fcpxml> [video_path]"})
        sys.exit(1)

    input_path  = sys.argv[1]
    clips_arg   = sys.argv[2]
    output_path = sys.argv[3]

    if not os.path.exists(input_path):
        log({"error": f"File not found: {input_path}"}); sys.exit(1)

    try:
        raw_arg = json.loads(clips_arg)
        if not isinstance(raw_arg, list) or not raw_arg:
            raise ValueError("argument must be a non-empty JSON array")

        # Legacy: single version passed as flat array of {start,end} dicts
        if isinstance(raw_arg[0], dict):
            versions = [raw_arg]
        else:
            versions = raw_arg

        raw = open(input_path, "r", encoding="utf-8").read()

        root     = ET.fromstring(re.sub(r"<!DOCTYPE[^>]*>", "", raw))
        sequence = root.find(".//sequence")
        if sequence is None:
            raise RuntimeError("No <sequence> found")
        spine = sequence.find("spine")
        if spine is None:
            raise RuntimeError("No <spine> found")

        tc_start  = parse_time(sequence.get("tcStart", "0/1s"))
        frame_dur = get_frame_dur(root, sequence)

        SPINE_TAGS = {"clip", "asset-clip", "mc-clip", "ref-clip"}
        outer_clips = [c for c in spine if c.tag in SPINE_TAGS]
        if not outer_clips:
            raise RuntimeError("No clip elements in spine")

        # Original timeline duration (used to compute per-version offsets)
        original_dur = parse_time(sequence.get("duration", "0/1s"))
        if original_dur == 0:
            # Fallback: derive from last clip's end position
            original_dur = max(
                parse_time(oc.get("offset", "0/1s")) + parse_time(oc.get("duration", "0/1s"))
                for oc in outer_clips
            )

        # Gap between versions: 60 seconds, snapped to frame boundary
        gap_dur = snap(Fraction(60), frame_dur)
        version_stride = original_dur + gap_dur

        # Find highest lane already in use across all primary clips
        ref_lane = 1
        for oc in outer_clips:
            for child in oc:
                try:
                    lane = int(child.get("lane", 0))
                    if lane >= ref_lane:
                        ref_lane = lane + 1
                except (ValueError, TypeError):
                    pass
        log({"status": "ref_lane", "lane": ref_lane,
             "versions": len(versions),
             "original_dur": float(original_dur),
             "version_stride": float(version_stride)})

        # Build spine elements for all versions
        all_spine_elements = []
        for i, version_clips in enumerate(versions):
            timeline_offset = i * version_stride
            version_spine = build_version_spine(
                outer_clips, version_clips, tc_start, frame_dur, ref_lane, timeline_offset
            )
            all_spine_elements.extend(version_spine)
            log({"status": "version_done", "version": i,
                 "clips": len(version_clips),
                 "spine_elements": len(version_spine),
                 "offset": float(timeline_offset)})

        # Update sequence duration to cover all versions
        n = len(versions)
        new_duration = n * original_dur + (n - 1) * gap_dur
        sequence.set("duration", fmt_time(new_duration))

        # Rebuild spine
        for child in list(spine):
            spine.remove(child)
        for child in all_spine_elements:
            spine.append(child)

        indent(root)
        xml_body = ET.tostring(root, encoding="unicode")
        out = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + xml_body

        with open(output_path, "w", encoding="utf-8") as f:
            f.write(out)

        log({"status": "done", "versions": n, "total_spine_elements": len(all_spine_elements),
             "new_duration": float(new_duration)})

    except Exception as e:
        import traceback
        log({"error": str(e), "trace": traceback.format_exc()})
        sys.exit(1)
