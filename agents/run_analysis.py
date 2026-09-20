"""Run style analysis and save the profile to a file."""
import json
import sys
import os

# Add agents dir to path
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

from touchline_agent import analyze_style

# Load posts
with open(os.path.join(script_dir, "my_posts.json"), "r", encoding="utf-8") as f:
    data = json.load(f)

posts = data.get("posts", [])
print(f"Analyzing {len(posts)} posts...")

# Run analysis
profile = analyze_style(posts)

# Save to file
output_path = os.path.join(script_dir, "style_profile.json")
with open(output_path, "w", encoding="utf-8") as f:
    json.dump(profile, f, ensure_ascii=False, indent=2)

print(f"Style profile saved to: {output_path}")
print(json.dumps(profile, ensure_ascii=False, indent=2))
