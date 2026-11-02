# Debian-based rather than the smaller `1-alpine`: InjusticeJudge needs Python
# with protobuf, which ships manylinux wheels for both amd64 and arm64 but would
# have to be compiled from source against musl — slow under QEMU and liable to
# break the arm64 build.
FROM oven/bun:1

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# InjusticeJudge is a library with no packaging metadata, so its dependencies go
# into a venv and the vendored source is reached through PYTHONPATH (see
# scripts/injustice.py). The venv also keeps pip away from Debian's
# externally-managed system Python. These are the four packages in the
# upstream Pipfile; websockets and protobuf are only used by its Mahjong Soul
# fetcher, but that module is imported unconditionally.
RUN python3 -m venv /opt/ij-venv \
 && /opt/ij-venv/bin/pip install --no-cache-dir \
      python-dotenv websockets requests protobuf

ENV INJUSTICE_PYTHON=/opt/ij-venv/bin/python3

COPY third_party/ ./third_party/
# Fails the build rather than the first reaction click if the submodule was not
# checked out (`git submodule update --init`, or submodules:true in CI), and
# import-checks the analyzer so a missing Python dependency surfaces here too.
RUN test -f third_party/InjusticeJudge/injustice_judge/__init__.py \
 || (echo "third_party/InjusticeJudge is empty — run: git submodule update --init --recursive"; exit 1)
RUN /opt/ij-venv/bin/python3 -c \
      "import sys; sys.path.insert(0, 'third_party/InjusticeJudge'); import injustice_judge; print('InjusticeJudge import OK')"

COPY scripts/ ./scripts/
COPY src/ ./src/
COPY tsconfig.json ./

CMD ["bun", "run", "src/index.ts"]
