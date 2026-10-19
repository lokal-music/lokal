
import React, { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTvMode } from './tvStore'
import './tv.css'

const pages = [
  ['Home', '/'],
  ['Search', '/search'],
  ['Library', '/library'],
  ['Settings', '/settings'],
]

export default function TvController() {
  const mode = useTvMode()
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [controllerConnected, setControllerConnected] = useState(false)
  const previousButtons = useRef({})
  const active =
    mode === 'on' ||
    (mode === 'auto' &&
      typeof navigator !== 'undefined' &&
      navigator.maxTouchPoints > 0)

  useEffect(() => {
    if (!active) {
      setMenuOpen(false)
      return
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setMenuOpen(value => !value)
        event.preventDefault()
        return
      }

      if (!event.key.startsWith('Arrow')) return

      const elements = [
        ...document.querySelectorAll(
          'button:not(:disabled), a[href], input, [tabindex="0"]'
        ),
      ].filter(element =>
        element.getClientRects().length > 0 &&
        !element.closest('.lokal-tv-overlay')
      )

      const current = document.activeElement
      const rect = current?.getBoundingClientRect?.()

      if (!rect || current === document.body) {
        elements[0]?.focus()
        return
      }

      event.preventDefault()

      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2

      const candidates = elements
        .filter(element => element !== current)
        .map(element => {
          const target = element.getBoundingClientRect()
          const dx = target.left + target.width / 2 - cx
          const dy = target.top + target.height / 2 - cy

          const forward =
            event.key === 'ArrowRight' ? dx > 0 :
            event.key === 'ArrowLeft' ? dx < 0 :
            event.key === 'ArrowDown' ? dy > 0 : dy < 0

          const distance = Math.hypot(dx, dy)
          const crossAxis =
            event.key === 'ArrowLeft' || event.key === 'ArrowRight'
              ? Math.abs(dy)
              : Math.abs(dx)

          return {
            element,
            score: forward ? distance + crossAxis * 1.5 : Infinity,
          }
        })
        .sort((a, b) => a.score - b.score)

      candidates[0]?.element.focus()
    }

    window.addEventListener('keydown', handleKeyDown, true)

    let animationFrame
    let running = true

    function pollGamepads() {
      if (!running) return

      const pads = navigator.getGamepads?.() || []
      const pad = [...pads].find(Boolean)

      if (pad) {
        setControllerConnected(true)
        const previous = previousButtons.current

        const pressed = index =>
          !!pad.buttons[index]?.pressed && !previous[index]

        if (pressed(0)) {
          document.activeElement?.click?.()
        }

        if (pressed(1) || pressed(9)) {
          setMenuOpen(value => !value)
        }

        const axes = pad.axes || []
        const directions = [
          [pressed(14) || axes[0] < -0.7, 'ArrowLeft'],
          [pressed(15) || axes[0] > 0.7, 'ArrowRight'],
          [pressed(12) || axes[1] < -0.7, 'ArrowUp'],
          [pressed(13) || axes[1] > 0.7, 'ArrowDown'],
        ]

        for (const [isPressed, key] of directions) {
          if (isPressed) {
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key, bubbles: true })
            )
          }
        }

        previousButtons.current = Object.fromEntries(
          pad.buttons.map((button, index) => [
            index,
            button.pressed,
          ])
        )
      } else {
        setControllerConnected(false)
        previousButtons.current = {}
      }

      animationFrame = requestAnimationFrame(pollGamepads)
    }

    animationFrame = requestAnimationFrame(pollGamepads)

    return () => {
      running = false
      cancelAnimationFrame(animationFrame)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [active])

  useEffect(() => {
    document.documentElement.classList.toggle('lokal-tv-mode', active)

    return () => {
      document.documentElement.classList.remove('lokal-tv-mode')
    }
  }, [active])

  if (!active) return null

  return (
    <>
      <div className="lokal-tv-status" aria-live="polite">
        TV MODE · {controllerConnected ? 'CONTROLLER CONNECTED' : 'READY'}
      </div>

      <button
        className="lokal-tv-menu-trigger"
        onClick={() => setMenuOpen(value => !value)}
        aria-label="Open TV navigation"
      >
        ☰
      </button>

      {menuOpen && (
        <div className="lokal-tv-overlay" role="dialog" aria-label="TV navigation">
          <div className="lokal-tv-panel">
            <div className="lokal-tv-panel-head">
              <strong>Lokal TV</strong>
              <button onClick={() => setMenuOpen(false)}>Close ✕</button>
            </div>

            <nav>
              {pages.map(([label, path]) => (
                <button
                  key={path}
                  className={location.pathname === path ? 'selected' : ''}
                  onClick={() => {
                    navigate(path)
                    setMenuOpen(false)
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>

            <p>
              Use the D-pad or arrow keys to navigate. A or Enter selects.
              B or Escape opens and closes this menu.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
