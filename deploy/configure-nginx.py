#!/usr/bin/env python3
"""Print a narrowly scoped update. The deployment script handles backup/reload."""
import re
import sys
from pathlib import Path

INCLUDE = 'include /etc/nginx/snippets/nd-ai-studio-api.conf;'

def mask(text):
    result = list(text)
    quote = None
    comment = False
    escaped = False
    for i, char in enumerate(text):
        if comment:
            if char == '\n':
                comment = False
            else:
                result[i] = ' '
        elif quote:
            result[i] = ' '
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
        elif char in ('"', "'"):
            quote = char
            result[i] = ' '
        elif char == '#':
            comment = True
            result[i] = ' '
    if quote:
        raise ValueError('Unterminated quote in Nginx configuration.')
    return ''.join(result)

def update(text):
    clean = mask(text)
    candidates = []
    for match in re.finditer(r'\bserver\s*\{', clean):
        start = match.end() - 1
        depth = 1
        end = start + 1
        while end < len(clean) and depth:
            depth += (clean[end] == '{') - (clean[end] == '}')
            end += 1
        if depth:
            raise ValueError('Unbalanced Nginx block.')
        block = clean[start:end]
        names = re.search(r'\bserver_name\s+([^;]+);', block)
        if names and 'ai.nightz.dev' in names.group(1).split() and re.search(r'\blisten\s+[^;]*\b443\b[^;]*\bssl\b', block):
            candidates.append((start, end))
    if len(candidates) != 1:
        raise ValueError('Expected exactly one existing ai.nightz.dev HTTPS server block. Nothing was changed.')
    start, end = candidates[0]
    block = text[start:end]
    if INCLUDE not in block:
        if re.search(r'\blocation\s+[^\{;]*(?:/api|/auth)', mask(block)):
            raise ValueError('Existing API or auth locations need manual review. Nothing was changed.')
        block = block[:-1] + '    ' + INCLUDE + '\n}'
    old = "img-src 'self' data:;"
    new = "img-src 'self' data: https://cdn.discordapp.com;"
    if old in block:
        block = block.replace(old, new)
    elif new not in block:
        raise ValueError('Unexpected image CSP. Review the site policy before adding Discord avatars.')
    return text[:start] + block + text[end:]

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: configure-nginx.py /path/to/ai.nightz.dev.conf')
    try:
        sys.stdout.write(update(Path(sys.argv[1]).read_text()))
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from error
