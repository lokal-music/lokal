// The backing singer owns an independent time window; it must follow the
// current focused lead, even when its original [bg:] row is attached to a
// previous lead in the enhanced-LRC parse. Mirrors Lokal Mobile's timed
// supporting-vocal selector without creating extra lead rows.
export function activeSupportingVocalIndex(lines, position) {
  if (!Number.isFinite(position)) return -1
  for (let i = 0; i < (lines?.length || 0); i++) {
    const line = lines[i]
    if (!line?.bgText) continue
    const words = line.bgWords
    const start = words?.length ? words[0].time : line.time
    let end = words?.length ? words[words.length - 1].end : start + 4
    if (!Number.isFinite(start)) continue
    if (!Number.isFinite(end) || end <= start) end = start + 0.5
    if (position >= start && position < end) return i
  }
  return -1
}
