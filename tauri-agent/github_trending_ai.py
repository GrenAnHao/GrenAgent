import json, urllib.request, urllib.parse, sys, time

def search_gh(query, per_page=10):
    encoded_q = urllib.parse.quote(query)
    url = f"https://api.github.com/search/repositories?q={encoded_q}&sort=stars&order=desc&per_page={per_page}"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "pi-agent"})
    data = json.load(urllib.request.urlopen(req, timeout=15))
    return data

queries = [
    ("ai", "AI general"),
    ("artificial-intelligence", "Artificial Intelligence"),
    ("llm", "LLM"),
    ("machine-learning", "Machine Learning"),
    ("deep-learning", "Deep Learning"),
]

seen = set()
all_items = []

for q, label in queries:
    try:
        query_str = f"{q}+created:%3E2026-06-07"
        data = search_gh(query_str, 10)
        print(f"Query '{label}': {data['total_count']} total, got {len(data['items'])} items", file=sys.stderr)
        for item in data["items"]:
            if item["id"] not in seen:
                seen.add(item["id"])
                all_items.append(item)
    except Exception as e:
        print(f"Query '{label}' failed: {e}", file=sys.stderr)
    time.sleep(0.3)

# Sort by stars
all_items.sort(key=lambda x: x["stargazers_count"], reverse=True)

print("\n" + "="*120)
print(f"TOP AI-RELATED REPOS (created after 2026-06-07) - Unique: {len(all_items)}")
print("="*120)

for i, item in enumerate(all_items[:25], 1):
    lang = item.get("language") or "N/A"
    desc = (item.get("description") or "No description")[:120]
    topics = ", ".join(item.get("topics", [])[:5])
    print(f"\n{i:2d}. {item['full_name']}")
    print(f"    ⭐ {item['stargazers_count']:>6} stars  |  🍴 {item['forks_count']} forks  |  {lang}")
    print(f"    {desc}")
    if topics:
        print(f"    Topics: {topics}")
    print(f"    {item['html_url']}")
