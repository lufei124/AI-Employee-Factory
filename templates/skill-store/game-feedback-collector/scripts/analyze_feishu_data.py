#!/usr/bin/env python3
"""Analyze the feishu feedback table dump (feedback_all.json) and print distributions."""
import json, sys, collections

def cell_to_str(v):
    if v is None:
        return None
    if isinstance(v, list):
        # multi-select option or list of strings
        return [x.get('text') if isinstance(x, dict) else x for x in v]
    return v

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'feedback_all.json'
    d = json.load(open(path))
    data = d.get('data', {})
    fields = data.get('fields', [])
    rows = data.get('data', [])
    print('has_more:', data.get('has_more'), '| count:', data.get('count'), '| fields:', fields)
    print('total records in this page:', len(rows))

    # Build index: field name -> column index
    col = {name: i for i, name in enumerate(fields)}

    cat_counter = collections.Counter()
    senti_counter = collections.Counter()
    source_counter = collections.Counter()
    n = 0
    for row in rows:
        n += 1
        def get(name):
            idx = col.get(name)
            if idx is None or idx >= len(row):
                return None
            return cell_to_str(row[idx])
        cats = get('反馈分类')
        if isinstance(cats, list):
            for c in cats:
                cat_counter[c] += 1
        senti = get('情感倾向')
        if isinstance(senti, list) and senti:
            senti_counter[senti[0]] += 1
        src = get('来源')
        if isinstance(src, list) and src:
            source_counter[src[0]] += 1

    print('\n=== 反馈分类分布 ===')
    for k, v in cat_counter.most_common():
        print(f'  {k!r}: {v}')
    print('\n=== 情感倾向分布 ===')
    for k, v in senti_counter.most_common():
        print(f'  {k!r}: {v}')
    print('\n=== 来源分布 ===')
    for k, v in source_counter.most_common():
        print(f'  {k!r}: {v}')
    print('\ntotal rows:', n)

if __name__ == '__main__':
    main()