'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const runDir = path.join(process.cwd(), 'artifacts', 'stage4-runs', 'stage4-1790541075638');
if (!fs.existsSync(runDir)) {
  console.error('Run directory not found:', runDir);
  process.exit(1);
}

const rawTelemetryPath = path.join(runDir, 'telemetry.jsonl');
const rawTranscriptPath = path.join(runDir, 'transcript.txt');
const resultPath = path.join(runDir, 'result.json');
const metadataPath = path.join(runDir, 'metadata.json');

const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};

// Compress telemetry
if (fs.existsSync(rawTelemetryPath)) {
  const rawTelemetry = fs.readFileSync(rawTelemetryPath);
  fs.writeFileSync(path.join(runDir, 'telemetry.jsonl.gz'), zlib.gzipSync(rawTelemetry));
  console.log('Compressed telemetry.jsonl.gz');
}

// Compress transcript
if (fs.existsSync(rawTranscriptPath)) {
  const rawTranscript = fs.readFileSync(rawTranscriptPath);
  fs.writeFileSync(path.join(runDir, 'transcript.txt.gz'), zlib.gzipSync(rawTranscript));
  console.log('Compressed transcript.txt.gz');
}

// Extract milestones
const milestones = result.milestones || [];
fs.writeFileSync(path.join(runDir, 'milestones.json'), JSON.stringify(milestones, null, 2), 'utf8');

// Parse telemetry for actions summary and damage timeline
const damageTimeline = [];
const actionsSummary = { totalAttempted: 0, succeeded: 0, failed: 0, actions: {}, failures: {} };

if (fs.existsSync(rawTelemetryPath)) {
  const lines = fs.readFileSync(rawTelemetryPath, 'utf8').split('\n');
  let lastHp = 20;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt.event === 'action_start') {
        actionsSummary.totalAttempted++;
        actionsSummary.actions[evt.action] = (actionsSummary.actions[evt.action] || 0) + 1;
      }
      if (evt.event === 'action_end') {
        if (evt.outcome === 'success') {
          actionsSummary.succeeded++;
        } else {
          actionsSummary.failed++;
          const failKey = `${evt.action}:${evt.reason || evt.outcome}`;
          actionsSummary.failures[failKey] = (actionsSummary.failures[failKey] || 0) + 1;
        }
      }
      let currentHp = null;
      if (evt.event === 'snapshot' && evt.state) currentHp = evt.state.health;
      else if (evt.health !== undefined) currentHp = evt.health;

      if (currentHp !== null && currentHp !== undefined) {
        if (currentHp < lastHp) {
          damageTimeline.push({
            timestamp: evt.timestamp,
            timeOfDay: evt.timeOfDay || evt.state?.timeOfDay || null,
            previousHealth: lastHp,
            currentHealth: currentHp,
            damageAmount: Math.round((lastHp - currentHp) * 100) / 100,
            event: evt.event,
            nearbyThreats: evt.state?.nearbyThreats || [],
          });
        }
        lastHp = currentHp;
      }
    } catch {}
  }
}

fs.writeFileSync(path.join(runDir, 'damage_timeline.json'), JSON.stringify(damageTimeline, null, 2), 'utf8');
fs.writeFileSync(path.join(runDir, 'actions_summary.json'), JSON.stringify(actionsSummary, null, 2), 'utf8');

// Config fingerprint
const configFingerprint = {
  schemaVersion: 1,
  runId: result.runId,
  timestamp: metadata.startTime || new Date().toISOString(),
  host: metadata.serverHost || 'localhost',
  port: metadata.serverPort || 61375,
  version: metadata.mcVersion || '1.21',
  sha256: crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
};
fs.writeFileSync(path.join(runDir, 'config_fingerprint.json'), JSON.stringify(configFingerprint, null, 2), 'utf8');

// Retained evidence files
const retainedFiles = [
  'result.json',
  'metadata.json',
  'config_fingerprint.json',
  'milestones.json',
  'damage_timeline.json',
  'actions_summary.json',
  'telemetry.jsonl.gz',
  'transcript.txt.gz',
];

const fileHashes = {};
for (const fileName of retainedFiles) {
  const filePath = path.join(runDir, fileName);
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath);
    fileHashes[fileName] = {
      sizeBytes: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  }
}

const manifest = {
  schemaVersion: 1,
  runId: result.runId,
  sourceCommit: result.sourceCommit,
  timestamp: new Date().toISOString(),
  verdict: result.verdict,
  passedGates: result.passedGates,
  totalGates: result.totalGates,
  files: fileHashes,
};
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

// IMPORTANT: result.json is never rewritten after hashing — the SHA-256 recorded in
// manifest.json must match the committed artifact file exactly. Any additional fields
// (evidencePath, manifest) are only written to the root stage4_live_results.json copy.
const rootResult = Object.assign({}, result, {
  evidencePath: path.relative(process.cwd(), runDir).replace(/\\/g, '/'),
  manifest,
});
const rootResultsPath = path.join(process.cwd(), 'stage4_live_results.json');
fs.writeFileSync(rootResultsPath, JSON.stringify(rootResult, null, 2), 'utf8');

// Post-packaging integrity check: re-hash result.json and verify it still matches manifest
const verifyContent = fs.readFileSync(resultPath);
const verifyHash = crypto.createHash('sha256').update(verifyContent).digest('hex');
const manifestHash = manifest.files['result.json']?.sha256;
if (verifyHash !== manifestHash) {
  console.error('INTEGRITY FAILURE: result.json sha256 mismatch after packaging!');
  console.error('  Expected (manifest):', manifestHash);
  console.error('  Actual   (file):    ', verifyHash);
  console.error('  The file was modified after hashing. Manifest is invalid.');
  process.exit(1);
}

console.log('Integrity check passed: result.json sha256 matches manifest.');
console.log('Successfully packaged historical evidence for run:', result.runId);
