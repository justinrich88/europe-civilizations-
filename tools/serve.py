#!/usr/bin/env python3
"""Dev server that refuses to be cached.

`python3 -m http.server` sends Last-Modified and no Cache-Control, which lets a
client apply heuristic freshness and hold a stale copy of a file that changed
seconds ago. The in-app preview browser does exactly that, and it does it in a
way `location.reload()` and even a forced navigation do not clear.

That failure is invisible and it is the worst kind: the page keeps running the
PREVIOUS build while every check you run reports a clean pass. It cost a full
verification round — a routing change was measured as "zero disagreements" when
the page had never loaded the routing change at all.

So every response here is `no-store`. This is a development server for a
zero-build project; there is nothing to gain from caching and everything to
lose.

    python3 tools/serve.py [port] [--directory DIR]

Defaults to port 8761 and the repository root.
"""

import argparse
import functools
import http.server
import os
import socketserver
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # no-store is the strong one: it forbids writing to any cache at all,
        # rather than merely requiring revalidation. Belt and braces below it
        # for clients that only honour the older headers.
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def send_header(self, keyword, value):
        # Last-Modified/ETag are what heuristic freshness keys off. Drop them so
        # there is nothing for a client to revalidate against in the first place.
        if keyword in ('Last-Modified', 'ETag'):
            return
        super().send_header(keyword, value)

    def log_message(self, fmt, *args):
        # One line per request, no client address — the address is always
        # localhost here and it doubles the width of every line.
        sys.stderr.write('%s\n' % (fmt % args))


class ReusableServer(socketserver.TCPServer):
    # Without this, restarting the server inside TIME_WAIT fails with
    # "Address already in use" for a minute, which reads like a port conflict.
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('port', nargs='?', type=int, default=8761)
    ap.add_argument('--directory', default=REPO_ROOT)
    args = ap.parse_args()

    handler = functools.partial(NoCacheHandler, directory=args.directory)
    with ReusableServer(('127.0.0.1', args.port), handler) as httpd:
        sys.stderr.write('serving %s on http://127.0.0.1:%d (no-store)\n'
                         % (args.directory, args.port))
        httpd.serve_forever()


if __name__ == '__main__':
    main()
