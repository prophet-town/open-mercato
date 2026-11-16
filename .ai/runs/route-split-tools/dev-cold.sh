#!/bin/bash
# usage: dev-cold.sh <label> : wipe the dev build cache and start `yarn dev:app` on :3000
R=/Volumes/CaseSensitive/repos/open-mercato
cd $R && rm -rf apps/mercato/.mercato/next/dev
echo "start $(date +%s)" > $R/.ai/runs/route-split-logs/$1-dev-start.txt
DATABASE_URL=postgres://mercato:secret@localhost:32887/mercato_test AUTO_SPAWN_WORKERS=false AUTO_SPAWN_SCHEDULER=false PORT=3000 yarn dev:app 2>&1 | tee $R/.ai/runs/route-split-logs/$1-dev.log
