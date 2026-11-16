#!/bin/bash
# usage: build-timed.sh <label>   cold then warm next build of apps/mercato, logs + timings
set -u
L=$1; R=/Volumes/CaseSensitive/repos/open-mercato; LOG=$R/.ai/runs/route-split-logs
cd $R/apps/mercato
rm -rf .mercato/next
s=$(date +%s); yarn build > $LOG/$L-build-cold.log 2>&1; rc=$?; e=$(date +%s)
echo "cold rc=$rc seconds=$((e-s))" | tee $LOG/$L-build-times.txt
s=$(date +%s); yarn build > $LOG/$L-build-warm.log 2>&1; rc=$?; e=$(date +%s)
echo "warm rc=$rc seconds=$((e-s))" | tee -a $LOG/$L-build-times.txt
du -sk .mercato/next .mercato/next/static .mercato/next/server .mercato/next/cache 2>/dev/null | tee -a $LOG/$L-build-times.txt
echo BUILD-DONE >> $LOG/$L-build-times.txt
