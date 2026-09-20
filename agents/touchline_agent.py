#!/usr/bin/env python3
"""
Touchline Agent — Consolidated AI assistant for The Touchline AR.

Combines patterns from 5 awesome-ai-apps projects into one tool:

  1. RouteLLM Pattern      — smart model routing (cheap vs strong)
  2. Human-in-the-Loop     — two-pass caption generation with retry
  3. Newsletter Pattern    — multi-stage research → analysis → generation
  4. Brand Monitor Pattern — web scraping + memory for deduplication
  5. Blog Writer Pattern   — style learning for consistent voice

Called from Node.js via subprocess. Receives JSON on stdin, outputs JSON on
stdout. No file I/O, no GUI — pure CLI tool.

Usage:
    echo '{"action":"research","type":"news","topic":"Barça vs Sevilla"}' | python touchline_agent.py
    echo '{"action":"generate","type":"news","context":{...},"style_profile":{...}}' | python touchline_agent.py
    echo '{"action":"verify","caption":"...","context":{...}}' | python touchline_agent.py
    echo '{"action":"route","query":"simple meme caption","type":"meme"}' | python touchline_agent.py
    echo '{"action":"style_analyze","posts":["post1","post2"]}' | python touchline_agent.py

Environment:
    LLM_API_KEY     — OpenRouter API key (required)
    LLM_BASE_URL    — API endpoint (default: https://openrouter.ai/api/v1)
    LLM_MODEL_STRONG — model for complex tasks (default: nvidia/nemotron-3-ultra-550b-a55b:free)
    LLM_MODEL_CHEAP — model for simple tasks (default: google/gemma-3-1b-it:free)
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from typing import Any, Optional

# ─── Configuration ──────────────────────────────────────────────────────────

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
STRONG_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
CHEAP_MODEL = "google/gemma-3-1b-it:free"

# Content types that are "simple" (don't need the strong reasoning model)
SIMPLE_TYPES = {"meme", "quote", "fact", "throwback"}

# Content types that need grounding (article data required)
GROUNDING_TYPES = {"news", "stats", "analysis"}

# Retry configuration
MAX_RETRIES = 5
RETRY_DELAYS = [2.5, 5, 10, 20, 40]
CAPTION_PACE_MS = 700

# ─── LLM Client ────────────────────────────────────────────────────────────

def get_llm_config():
    """Get LLM configuration from environment variables."""
    api_key = os.environ.get("LLM_API_KEY")
    if not api_key:
        raise ValueError("LLM_API_KEY env var not set")
    return {
        "api_key": api_key,
        "base_url": os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL),
        "model_strong": os.environ.get("LLM_MODEL_STRONG", STRONG_MODEL),
        "model_cheap": os.environ.get("LLM_MODEL_CHEAP", CHEAP_MODEL),
    }


def chat_completion(messages: list[dict], model: str, temperature: float = 0.7,
                    max_tokens: int = 1200) -> str:
    """Call OpenAI-compatible chat completions with retry logic."""
    config = get_llm_config()

    url = f"{config['base_url'].rstrip('/')}/chat/completions"
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config['api_key']}",
        "HTTP-Referer": "https://github.com/hamzahamad207-art/football-new",
        "X-Title": "TouchlineAR-Agent",
    }

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            data = json.dumps(body).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content and content.strip():
                    return content.strip()
                # Empty content — retry
                last_error = "LLM returned empty content"
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503):
                last_error = f"HTTP {e.code}: {e.reason}"
                # Rate limited or server error — retry with backoff
            else:
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = f"Network error: {e}"

        if attempt < MAX_RETRIES:
            time.sleep(RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)])

    raise RuntimeError(f"LLM failed after {MAX_RETRIES} attempts: {last_error}")


# ─── Action 1: Smart Model Routing (RouteLLM pattern) ──────────────────────

ROUTING_RULES = {
    # Simple types → cheap model (no article data needed)
    "meme": "cheap",
    "quote": "cheap",
    "fact": "cheap",
    "throwback": "cheap",
    # Complex types → strong model (needs grounding, analysis)
    "news": "strong",
    "stats": "strong",
    "analysis": "strong",
}

# Keywords that indicate complexity even in simple types
COMPLEX_KEYWORDS = [
    "transfer", "breaking", "injury", "suspension", "tactical",
    "record", "historic", "debut", "rivalry",
    "انتقال", "إصابة", " suspension", "تحليلي", "رقم قياسي",
]


def route_query(content_type: str, topic: str = "", context: dict | None = None) -> dict:
    """Decide which model to use based on content type and context.

    Returns {"model": "strong"|"cheap", "reason": "..."}.
    """
    # Check content type rules first
    rule = ROUTING_RULES.get(content_type)
    if rule:
        model = rule
        reason = f"Content type '{content_type}' → {model} model"
    else:
        model = "strong"
        reason = "Unknown type — defaulting to strong model"

    # Override: if there's article context with facts/recap, use strong
    if context and (context.get("recap") or context.get("facts")):
        if model == "cheap":
            model = "strong"
            reason = "Has article data with facts — upgraded to strong model for grounding"

    # Override: if topic mentions complex keywords, use strong
    topic_lower = (topic or "").lower()
    if any(kw in topic_lower for kw in COMPLEX_KEYWORDS):
        if model == "cheap":
            model = "strong"
            reason = f"Topic contains complex keyword → strong model"

    return {"model": model, "reason": reason}


# ─── Action 2: Two-Pass Caption Generation (HITL pattern) ──────────────────

def generate_caption_two_pass(system_prompt: str, user_prompt: str,
                               temperature: float = 0.7,
                               type_name: str = "news") -> dict:
    """Generate a caption using two draws, keeping the better one.

    Draw A runs first. If it passes all basic checks, Draw B is skipped
    (saves time — same pattern as the Node.js bot).

    Returns {"caption": str, "draw": "A"|"B", "skipped_b": bool, "checks_passed": bool}.
    """
    # Draw A
    config = get_llm_config()
    caption_a = chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model=config["model_strong"],
        temperature=temperature,
    )
    caption_a = clean_caption(caption_a)

    checks_passed = pass_basic_checks(caption_a, type_name)

    if checks_passed:
        return {
            "caption": caption_a,
            "draw": "A",
            "skipped_b": True,
            "checks_passed": True,
        }

    # Draw B (different temperature for variety)
    time.sleep(CAPTION_PACE_MS / 1000)
    caption_b = chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model=config["model_strong"],
        temperature=min(temperature + 0.1, 1.0),
    )
    caption_b = clean_caption(caption_b)

    # Score both and pick the better one
    score_a = score_caption(caption_a, type_name)
    score_b = score_caption(caption_b, type_name)

    best = caption_a if score_a >= score_b else caption_b
    winner = "A" if score_a >= score_b else "B"

    return {
        "caption": best,
        "draw": winner,
        "skipped_b": False,
        "checks_passed": False,
        "score_a": score_a,
        "score_b": score_b,
    }


def clean_caption(text: str) -> str:
    """Strip markdown fences, stray quotes, asterisks from LLM output."""
    text = text.strip()
    # Remove markdown code fences
    text = re.sub(r"^```[\s\S]*?\n", "", text)
    text = re.sub(r"\n```$", "", text)
    text = text.strip('"\'')
    text = text.strip("*").strip()
    # Remove emoji-only lines (keep emoji inline)
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        stripped = line.strip()
        # Skip lines that are only emoji
        if stripped and not re.match(r'^[\U00010000-\U0010ffff\s]+$', stripped):
            cleaned.append(line)
    return "\n".join(cleaned).strip()


def pass_basic_checks(caption: str, type_name: str) -> bool:
    """Quick checks — if all pass, skip Draw B."""
    if not caption or len(caption) < 10:
        return False
    # No Latin in first line (except score headers)
    first_line = caption.split("\n")[0].strip()
    if not re.match(r'^(FT|LIVE|NEXT|HT|ET|BREAKING|CLOSE)\s*:', first_line):
        if re.search(r'[a-zA-Z]{3,}', first_line):
            return False
    # No English gibberish artifacts
    if re.search(r'_[a-z]+|`[^`]+`', caption):
        return False
    # Must contain Arabic
    if not re.search(r'[\u0600-\u06FF]', caption):
        return False
    return True


def score_caption(caption: str, type_name: str) -> int:
    """Score a caption on multiple dimensions. Higher = better."""
    score = 0

    # Length: 50-300 chars is ideal for Threads
    length = len(caption)
    if 50 <= length <= 300:
        score += 10
    elif 30 <= length <= 400:
        score += 5

    # Arabic content
    arabic_chars = len(re.findall(r'[\u0600-\u06FF]', caption))
    total_chars = max(len(caption), 1)
    arabic_ratio = arabic_chars / total_chars
    score += int(arabic_ratio * 20)

    # No Latin (except score headers)
    first_line = caption.split("\n")[0].strip()
    if not re.match(r'^(FT|LIVE|NEXT|HT|ET|BREAKING|CLOSE)\s*:', first_line):
        if re.search(r'[a-zA-Z]{3,}', first_line):
            score -= 50  # Latin in first line is bad (leaks into overlay)

    # Emoji count (1-3 is ideal)
    emoji_count = len(re.findall(r'[\U00010000-\U0010ffff]', caption))
    if 1 <= emoji_count <= 3:
        score += 5
    elif emoji_count > 5:
        score -= 5

    # Football vocabulary bonus
    football_terms = [
        "مباراة", "هدف", "نادي", "فريق", "لاعب", "دوري", "كأس",
        "بطولة", "جمهور", "مدرب", "دفاع", "هجوم", "وسط",
    ]
    if any(term in caption for term in football_terms):
        score += 5

    # Penalize English artifacts
    if re.search(r'_\w+|`[^`]+`', caption):
        score -= 100

    # Penalize repeated lines
    lines = [l.strip() for l in caption.split("\n") if l.strip()]
    if len(lines) != len(set(lines)):
        score -= 30

    return score


# ─── Action 3: Multi-Stage Research (Newsletter pattern) ───────────────────

def research_context(content_type: str, topic: str = "",
                     article_data: dict | None = None) -> dict:
    """Enrich context with web research.

    For news: scrape the article URL for full body text + additional images.
    For canned types: generate 2-3 relevant talking points.

    Returns enhanced context dict.
    """
    ctx = article_data or {}

    if content_type in GROUNDING_TYPES and ctx.get("article_url"):
        # Scrape the article for full body text
        try:
            body_text = scrape_article_body(ctx["article_url"])
            if body_text:
                ctx["full_body"] = body_text[:2000]  # cap at 2000 chars
        except Exception:
            pass  # Non-fatal — use what we have

    if content_type in SIMPLE_TYPES:
        # Generate talking points for canned types
        try:
            points = generate_talking_points(content_type, topic)
            ctx["talking_points"] = points
        except Exception:
            pass

    return ctx


def scrape_article_body(url: str) -> str:
    """Fetch a URL and extract plain text body (best-effort, no dependencies)."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; TouchlineBot/2.0)",
            "Accept": "text/html",
        })
        with urllib.request.urlopen(req, timeout=6) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        # Simple HTML-to-text: strip tags, collapse whitespace
        text = re.sub(r'<script[\s\S]*?</script>', '', html, flags=re.I)
        text = re.sub(r'<style[\s\S]*?</style>', '', text, flags=re.I)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'&\w+;', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()

        # Extract the main content area (heuristic: longest text block)
        # This is a rough approximation — good enough for context enrichment
        sentences = text.split('. ')
        if len(sentences) > 10:
            # Take the middle 60% (likely the article body)
            start = len(sentences) // 5
            end = len(sentences) * 4 // 5
            return '. '.join(sentences[start:end])
        return text
    except Exception:
        return ""


def generate_talking_points(content_type: str, topic: str) -> list[str]:
    """Generate 2-3 talking points for a canned content type."""
    config = get_llm_config()
    prompt_map = {
        "meme": f"Generate 2-3 short, funny Khaleeji Arabic football observations or jokes about: {topic or 'كرة القدم'}. Keep each under 15 words.",
        "quote": f"Suggest 2-3 real, famous football quotes (with attribution) that would work in Khaleeji Arabic context about: {topic or 'كرة القدم'}.",
        "fact": f"Share 2-3 interesting, verified football facts about: {topic or 'كرة القدم'}. Each should be one sentence.",
        "throwback": f"Suggest 2-3 nostalgic football moments or iconic events about: {topic or 'كرة القدم'}. Each should be one sentence.",
    }
    prompt = prompt_map.get(content_type, f"Give 2-3 brief talking points about: {topic}")

    try:
        response = chat_completion(
            messages=[{"role": "user", "content": prompt}],
            model=config["model_cheap"],
            temperature=0.8,
            max_tokens=300,
        )
        # Split into individual points
        points = [p.strip() for p in re.split(r'\n\d+[.):\s]|•|-', response) if p.strip()]
        return points[:3]
    except Exception:
        return []


# ─── Action 4: Fact Verification (Brand Monitor pattern) ───────────────────

def verify_caption(caption: str, context: dict) -> dict:
    """Verify a caption against the source data for fact-grounding.

    Returns {"passed": bool, "issues": [...], "score": int}.
    """
    issues = []
    score = 100  # Start perfect, deduct for issues

    # Extract entities from context
    source_text = " ".join([
        context.get("header", ""),
        context.get("recap", ""),
        context.get("facts", ""),
        context.get("topic", ""),
        context.get("full_body", ""),
    ]).lower()

    # Check 1: No invented club names
    # Common Arabic club names that should be grounded
    club_patterns = [
        "ريال مدريد", "برشلونة", "تشيلسي", "ليفربول", "مانشستر",
        "أرسنال", "بايرن", "يوفنتوس", "إنتر", "ميلان", "باريس",
        "الهلال", "النصر", "الأهلي", "الاتحاد", "الزمالك",
        "توتنهام", "نيوكاسل", "سيتي",
    ]
    for club in club_patterns:
        if club in caption and club not in source_text:
            issues.append(f"Un grounded club name: '{club}' — not found in source data")
            score -= 30

    # Check 2: No invented player names (check common ones)
    player_patterns = [
        "ميسي", "رونالدو", "مبابي", "صلاح", "هالاند", "ليفاندوفسكي",
        "رافينيا", "بيلينغهام", "فينيسيوس", "모드리치",
    ]
    for player in player_patterns:
        if player in caption and player not in source_text:
            issues.append(f"Un grounded player name: '{player}' — not found in source data")
            score -= 25

    # Check 3: Arabic-only (except score headers)
    first_line = caption.split("\n")[0].strip()
    if not re.match(r'^(FT|LIVE|NEXT|HT|ET|BREAKING|CLOSE)\s*:', first_line):
        latin_matches = re.findall(r'[a-zA-Z]{3,}', first_line)
        if latin_matches:
            issues.append(f"Latin text in first line: {latin_matches} — will leak into overlay image")
            score -= 40

    # Check 4: No English gibberish
    gibberish = re.findall(r'_[a-z]+|`[^`]+`|^\s*\*\*', caption)
    if gibberish:
        issues.append(f"LLM artifacts detected: {gibberish}")
        score -= 20

    # Check 5: Derby/Clasico rule
    if "كلاسيكو" in caption:
        has_rm = "ريال مدريد" in source_text
        has_barca = "برشلونة" in source_text
        if not (has_rm and has_barca):
            issues.append("'كلاسيكو' used but source doesn't cover Real Madrid + Barcelona — should be 'ديربي'")
            score -= 15

    # Check 6: Must contain Arabic
    if not re.search(r'[\u0600-\u06FF]', caption):
        issues.append("No Arabic characters found in caption")
        score -= 50

    return {
        "passed": len(issues) == 0,
        "issues": issues,
        "score": max(score, 0),
    }


# ─── Action 5: Style Analysis (Blog Writer pattern) ───────────────────────

def analyze_style(posts: list[str]) -> dict:
    """Analyze a set of existing posts to extract a style profile.

    Returns a JSON-serializable style profile that can be stored and
    injected into future prompts for consistent voice.
    """
    if not posts:
        return {"error": "No posts provided for analysis"}

    # Try LLM-based analysis first, fall back to basic stats
    try:
        config = get_llm_config()
        combined = "\n---\n".join(posts[:20])  # Cap at 20 posts

        analysis_prompt = f"""Analyze these Khaleeji Arabic football posts and extract a writing style profile.

POSTS:
{combined}

Return ONLY a JSON object with these fields:
{{
  "tone": "brief description of the overall tone (1-2 words)",
  "voice": "formal|casual|fan-like|journalistic|mixed",
  "avg_sentence_length": <number of words per sentence>,
  "closing_style": "question|sharp_comment|prediction|mixed",
  "emoji_frequency": "heavy|moderate|light|none",
  "common_openers": ["list of common first-line patterns"],
  "common_closers": ["list of common closing line patterns"],
  "vocabulary_level": "simple|moderate|advanced",
  "arabic_dialect": "khaleeji|egyptian|levantine|mixed",
  "content_emphasis": "facts|emotion|analysis|humor|mixed",
  "recommended_system_prompt_addition": "a short Arabic instruction to add to the system prompt for style consistency"
}}"""

        response = chat_completion(
            messages=[{"role": "user", "content": analysis_prompt}],
            model=config["model_strong"],
            temperature=0.3,
            max_tokens=800,
        )
        # Extract JSON from response
        json_match = re.search(r'\{[\s\S]*\}', response)
        if json_match:
            return json.loads(json_match.group())
    except Exception:
        pass

    # Fallback: basic statistical analysis (no LLM needed)
    return analyze_style_basic(posts)


def analyze_style_basic(posts: list[str]) -> dict:
    """Fallback style analysis using simple statistics."""
    all_text = "\n".join(posts)

    # Count emoji
    emoji_count = len(re.findall(r'[\U00010000-\U0010ffff]', all_text))
    avg_emoji = emoji_count / max(len(posts), 1)

    # Count questions
    question_count = len(re.findall(r'[؟?]', all_text))
    avg_questions = question_count / max(len(posts), 1)

    # Average length
    avg_length = sum(len(p) for p in posts) / max(len(posts), 1)

    # Common closers
    closers = []
    for post in posts:
        lines = [l.strip() for l in post.split("\n") if l.strip()]
        if lines:
            closers.append(lines[-1])

    return {
        "tone": "passionate" if avg_emoji > 2 else "informative",
        "voice": "fan-like",
        "avg_sentence_length": avg_length / max(len(posts), 1),
        "closing_style": "mixed" if avg_questions > 0.5 else "sharp_comment",
        "emoji_frequency": "heavy" if avg_emoji > 3 else "moderate" if avg_emoji > 1 else "light",
        "common_openers": [],
        "common_closers": closers[:5],
        "vocabulary_level": "moderate",
        "arabic_dialect": "khaleeji",
        "content_emphasis": "emotion",
        "recommended_system_prompt_addition": "",
    }


# ─── Action 6: Generate with Style (Blog Writer integration) ───────────────

def generate_with_style(system_prompt: str, user_prompt: str,
                        style_profile: dict | None = None,
                        temperature: float = 0.7) -> str:
    """Generate a caption with style profile injection.

    If a style profile is provided, appends style instructions to the
    system prompt for consistent voice matching.
    """
    enhanced_system = system_prompt

    if style_profile and style_profile.get("recommended_system_prompt_addition"):
        enhanced_system += "\n\n" + style_profile["recommended_system_prompt_addition"]

    if style_profile:
        style_notes = []
        if style_profile.get("tone"):
            style_notes.append(f"النبرة: {style_profile['tone']}")
        if style_profile.get("closing_style"):
            style_notes.append(f"النهاية: {style_profile['closing_style']}")
        if style_profile.get("emoji_frequency"):
            emoji_guide = {
                "heavy": "3-5 إيموجي في كل منشور",
                "moderate": "1-3 إيموجي في كل منشور",
                "light": "1 إيموجي فقط أو بدون",
                "none": "بدون إيموجي",
            }
            style_notes.append(emoji_guide.get(style_profile["emoji_frequency"], ""))

        if style_notes:
            enhanced_system += "\n\nتتبع أسلوب الحساب:\n" + "\n".join(style_notes)

    config = get_llm_config()
    return chat_completion(
        messages=[
            {"role": "system", "content": enhanced_system},
            {"role": "user", "content": user_prompt},
        ],
        model=config["model_strong"],
        temperature=temperature,
    )


# ─── Main Dispatcher ───────────────────────────────────────────────────────

def handle_request(request: dict) -> dict:
    """Main dispatcher — routes to the appropriate action handler."""
    action = request.get("action", "")

    if action == "route":
        result = route_query(
            content_type=request.get("type", "news"),
            topic=request.get("topic", ""),
            context=request.get("context"),
        )

    elif action == "generate":
        result = generate_caption_two_pass(
            system_prompt=request.get("system_prompt", ""),
            user_prompt=request.get("user_prompt", ""),
            temperature=request.get("temperature", 0.7),
            type_name=request.get("type", "news"),
        )

    elif action == "generate_with_style":
        caption = generate_with_style(
            system_prompt=request.get("system_prompt", ""),
            user_prompt=request.get("user_prompt", ""),
            style_profile=request.get("style_profile"),
            temperature=request.get("temperature", 0.7),
        )
        result = {"caption": caption}

    elif action == "verify":
        result = verify_caption(
            caption=request.get("caption", ""),
            context=request.get("context", {}),
        )

    elif action == "research":
        result = research_context(
            content_type=request.get("type", "news"),
            topic=request.get("topic", ""),
            article_data=request.get("article_data"),
        )

    elif action == "style_analyze":
        result = analyze_style(
            posts=request.get("posts", []),
        )

    elif action == "score":
        result = {
            "score": score_caption(
                caption=request.get("caption", ""),
                type_name=request.get("type", "news"),
            )
        }

    elif action == "health":
        config = get_llm_config()
        result = {
            "status": "ok",
            "model_strong": config["model_strong"],
            "model_cheap": config["model_cheap"],
            "base_url": config["base_url"],
        }

    else:
        result = {"error": f"Unknown action: '{action}'"}

    return result


# ─── Entry Point ────────────────────────────────────────────────────────────

def main():
    """Read JSON from stdin, dispatch, write JSON to stdout."""
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
        result = handle_request(request)
        print(json.dumps(result, ensure_ascii=False))
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)
    except (ValueError, RuntimeError, OSError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
