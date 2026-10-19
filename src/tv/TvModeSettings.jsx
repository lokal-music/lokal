
import React from 'react'
import { setTvMode, useTvMode } from './tvStore'

export default function TvModeSettings() {
  const mode = useTvMode()

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-white">TV Mode</p>
        <p className="text-xs text-white/55 mt-1">
          Controller-friendly navigation and clear focus indicators
          for a TV or couch setup. Your existing player stays unchanged.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {[
          ['auto', 'Automatic'],
          ['on', 'On'],
          ['off', 'Off'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTvMode(value)}
            aria-pressed={mode === value}
            className={
              'px-3 py-2 rounded-lg border text-xs ' +
              (mode === value
                ? 'border-violet-400 bg-violet-500/20 text-white'
                : 'border-white/10 text-white/60 hover:text-white')
            }
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
