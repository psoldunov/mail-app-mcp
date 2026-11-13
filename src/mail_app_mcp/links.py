"""Bounded HTML link extraction from Mail's MIME source; never fetches URLs."""

import base64
import email
import email.policy
from html.parser import HTMLParser
from urllib.parse import urlsplit

MAX_SOURCE_CHARS = 100_000
MAX_LINKS = 100
MAX_URL_CHARS = 2048
MAX_LABEL_CHARS = 256


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.url = None
        self.label = ""
        self.truncated = False

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        self.handle_endtag("a")
        url = dict(attrs).get("href") or ""
        if len(url) > MAX_URL_CHARS:
            self.truncated = True
            return
        if any(ord(char) < 32 for char in url):
            return
        try:
            parsed = urlsplit(url)
        except ValueError:
            return
        if parsed.scheme in {"http", "https", "mailto"}:
            self.url = url

    def handle_data(self, data):
        if self.url is not None:
            self.truncated |= len(self.label) + len(data) > MAX_LABEL_CHARS
            self.label = (self.label + data)[:MAX_LABEL_CHARS]

    def handle_endtag(self, tag):
        if tag != "a" or self.url is None:
            return
        link = {"url": self.url, "text": " ".join(self.label.split())}
        if link not in self.links:
            if len(self.links) < MAX_LINKS:
                self.links = [*self.links, link]
            else:
                self.truncated = True
        self.url = None
        self.label = ""


def message_links(source: str | None, truncated: bool = False) -> dict:
    if not source or len(source) > MAX_SOURCE_CHARS:
        return {"links": [], "links_truncated": True}
    parser = Links()
    try:
        message = email.message_from_string(source, policy=email.policy.default)
        part = message.get_body(preferencelist=("html",))
        if part is None:
            return {"links": [], "links_truncated": truncated}
        if truncated and part.get("Content-Transfer-Encoding", "").lower() == "base64":
            payload = "".join(part.get_payload().split())
            # A cut base64 quantum can make the MIME decoder return the entire payload undecoded.
            content = base64.b64decode(payload[:len(payload) // 4 * 4], validate=True).decode(
                part.get_content_charset() or "ascii", errors="replace")
        else:
            content = part.get_content()
        parser.feed(content)
        parser.close()
        if not truncated:
            parser.handle_endtag("a")
    except (LookupError, ValueError, RecursionError):
        return {"links": [], "links_truncated": True}
    return {"links": parser.links, "links_truncated": truncated or parser.truncated}
