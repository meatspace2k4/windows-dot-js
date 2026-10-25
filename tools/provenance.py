"""The provenance line each generated bundle starts with: the tool files that made it and a hash of their bytes.
deploy/win95/deploy.sh recomputes the hash from the checkout and refuses a bundle the tools no longer make.

    // tools: tools/build_savers.py,tools/recomp.py sha256=<hex>
"""
import hashlib, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def digest(files):
    h = hashlib.sha256()
    for rel in files:
        h.update(rel.encode() + b'\0')
        with open(os.path.join(ROOT, rel), 'rb') as f: h.update(f.read())
        h.update(b'\0')
    return h.hexdigest()


def line(*files):
    return f'// tools: {",".join(files)} sha256={digest(files)}\n'


if __name__ == '__main__':
    import sys
    print(digest(sys.argv[1].split(',')))
