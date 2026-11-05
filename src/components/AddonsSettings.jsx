// Settings → Addons: Mornye repositories/packages and HTTP sources.

import { useTranslation } from '../i18n'
import React, { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { AlertTriangle, Blocks, CheckCircle2, Loader2, ShieldAlert, Trash2, RefreshCw, Upload } from 'lucide-react'
import { api } from '../api'
import { peekCache, usePageReady, writeCache } from '../pageCache'

const changed = () => window.dispatchEvent(new Event('lokal:addons-changed'))

/** One field from an addon's manifest "settings". */
function SettingField({ field, value, onChange, onAction }) {
  const { t } = useTranslation()
  const id = `addon-setting-${field.key}`
  const label = <label htmlFor={id} className="text-xs font-medium text-text">{t(field.label || field.key)}</label>
  const help = field.help ? <p className="text-[11px] leading-relaxed text-muted">{t(field.help)}</p> : null
  if (field.type === 'button') return <div><button className="rounded-lg border border-border px-3 py-2 text-xs text-accent" onClick={() => onAction?.(field.action)}>{t(field.label || field.key)}</button>{help}</div>
  if (field.type === 'toggle') {
    const on = value === true || value === 'true'
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">{label}{help}</div>
        <button id={id} role="switch" aria-checked={on} onClick={() => onChange(!on)}
          className={`flex-shrink-0 rounded-lg border px-3 py-1 text-[11px] font-display uppercase tracking-wider transition-colors ${on ? 'border-accent/50 bg-accent/20 text-accent' : 'border-border text-muted hover:text-text'}`}>
          {on ? t('On') : t('Off')}
        </button>
      </div>
    )
  }
  if (field.type === 'select') {
    return (
      <div className="space-y-1">
        {label}
        <select id={id} value={String(value ?? '')} onChange={e => onChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent/50">
          {(field.options || []).map(o => <option key={String(o.value)} value={String(o.value)}>{t(o.label || o.value)}</option>)}
        </select>
        {help}
      </div>
    )
  }
  return (
    <div className="space-y-1">
      {label}
      <input id={id} type={field.secret || field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'} autoComplete="off" value={String(value ?? '')} placeholder={field.placeholder || ''}
        onChange={e => onChange(field.type === 'number' ? e.target.value : e.target.value)}
        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent/50" />
      {help}
    </div>
  )
}

/** An installed addon: header, on/off, remove, and its settings. */
function AddonCard({ addon, onChanged, focused = false }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(focused)
  const cardRef = useRef(null)
  const [values, setValues] = useState(addon.settings || {})
  const [signingKey, setSigningKey] = useState('')
  const [clearSigningKey, setClearSigningKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [message, setMessage] = useState('')
  const [auth, setAuth] = useState(null)
  const [form, setForm] = useState(null)
  const [formInput, setFormInput] = useState({})
  useEffect(() => { setValues(addon.settings || {}) }, [addon.settings])
  // Opened from a "finish setting up" link: this card, opened and in view.
  useEffect(() => { if (focused) { setOpen(true); cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }) } }, [focused])
  // The login / verification window closed: its access was checked again.
  useEffect(() => api.onAddonAuthChanged(status => {
    if (status?.key !== addon.key) return
    setAuth(status)
    setMessage(status.authenticated ? t('Access verified. This source can now stream and download.') : t(status.error || "Verification wasn't completed. Try again when you're ready."))
    onChanged()
  }), [addon.key, t])
  const needsSetup = addon.enabled && addon.access && !addon.access.ready
  const verified = auth ? !!auth.authenticated : !!addon.access?.verified

  const update = (key, value) => setValues(current => ({ ...current, [key]: value }))
  const run = async work => {
    setBusy(true); setMessage('')
    try { const result = await work(); if (result?.error || result?.success === false) throw new Error(result?.error || result?.error_message || 'Addon action failed'); return result }
    catch (error) { setMessage(t(error.message)); return null }
    finally { setBusy(false) }
  }
  const save = () => run(async () => {
    const keyOption = clearSigningKey ? { signingKey: '' } : signingKey ? { signingKey } : {}
    const result = await api.addonsSetSettings(addon.key, values, keyOption)
    if (!result?.error) { setSigningKey(''); setClearSigningKey(false); setMessage(t('Settings saved')); onChanged() }
    return result
  })
  const toggle = async () => {
    if (await run(() => api.addonsSetEnabled(addon.key, !addon.enabled))) onChanged()
  }
  const remove = async () => {
    if (await run(() => api.addonsRemove(addon.key))) onChanged()
  }
  const action = (id, input, token) => run(async () => {
    const result = await api.addonsPackages({ action: 'package.action', key: addon.key, id, input, token })
    const schema = result?.action_form || result?.byoa_form
    setForm(schema ? { ...schema, token: result.formToken } : null); setFormInput({})
    if (result?.open_auth_url && /^https:\/\//i.test(result.open_auth_url)) {
      // A login page: the desktop app opens it in its own window and checks
      // access when it closes (no callback link to copy back).
      if (api.isElectron) await api.addonsPackages({ action: 'package.openAuth', key: addon.key }).catch(() => null)
      else setAuth({ open_auth_url: result.open_auth_url })
    }
    if (result?.message) setMessage(t(result.message))
    return result
  })
  const verify = () => run(async () => {
    const result = await api.addonsPackages({ action: 'package.verify', key: addon.key })
    setAuth(result)
    if (result?.opened) setMessage(t("Complete the verification in the window that opened. Access is checked when it closes."))
    else if (result?.authenticated) { setMessage(t("Access verified.")); onChanged() }
    return result
  })

  return (
    <div ref={cardRef} className={`rounded-xl border bg-card/60 p-4 ${needsSetup ? 'border-yellow-500/30' : 'border-border'} ${addon.enabled ? '' : 'opacity-70'}`}>
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg bg-elevated">
          {addon.icon ? <img src={addon.icon} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : <div className="flex h-full w-full items-center justify-center text-muted"><Blocks size={16} /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text">{addon.name} <span className="text-xs font-normal text-muted">v{addon.version}</span></p>
          <p className="text-[11px] text-muted">{addon.linksOnly ? t('Mornye package · reads playlist links for playlist sync') : addon.host}</p>
          {needsSetup && <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] text-yellow-300"><ShieldAlert size={11} />{addon.access.missing?.length ? t('Needs {capabilities}', { capabilities: addon.access.missing.map(item => t(item)).join(', ') }) : addon.access.kind === 'login' ? t('Needs login') : t('Needs verification')}</p>}
          {addon.description && <p className="mt-1 text-xs leading-relaxed text-muted">{addon.description}</p>}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button onClick={toggle} disabled={busy}
            className={`rounded-lg border px-3 py-1 text-[11px] font-display uppercase tracking-wider transition-colors ${addon.enabled ? 'border-accent/50 bg-accent/20 text-accent' : 'border-border text-muted hover:text-text'}`}>
            {addon.enabled ? t('On') : t('Off')}
          </button>
          {confirmRemove ? (
            <button onClick={remove} disabled={busy} className="rounded-lg border border-red/40 px-2.5 py-1 text-[11px] text-red hover:bg-red/10">{t("Remove?")}</button>
          ) : (
            <button onClick={() => setConfirmRemove(true)} title={t("Remove addon")} aria-label={`Remove ${addon.name}`} className="p-1 text-muted hover:text-red"><Trash2 size={14} /></button>
          )}
        </div>
      </div>
      {(addon.settingsSchema.length > 0 || addon.kind !== 'mornye') && (
        <div className="mt-3">
          <button onClick={() => setOpen(v => !v)} className="text-xs text-accent hover:underline">{open ? t('Hide settings') : t('Settings & access')}</button>
          {open && (
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              {addon.kind !== 'mornye' && <div className="space-y-1">
                <label htmlFor={`addon-signing-key-${addon.key}`} className="text-xs font-medium text-text">{t('HMAC signing key (optional)')}</label>
                <input id={`addon-signing-key-${addon.key}`} type="password" autoComplete="new-password" spellCheck={false}
                  value={signingKey} disabled={clearSigningKey} onChange={e => setSigningKey(e.target.value)}
                  placeholder={addon.hasSigningKey ? t('Configured — enter a replacement') : t('Leave empty for unsigned requests')}
                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent/50" />
                {addon.hasSigningKey && <label className="flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={clearSigningKey} onChange={e => { setClearSigningKey(e.target.checked); if (e.target.checked) setSigningKey('') }} />{t('Remove saved HMAC key')}</label>}
                <p className="text-[11px] text-muted">{t('Used only for signed requests to this add-on. Leave empty to keep the current key, if any.')}</p>
              </div>}
              {addon.settingsSchema.filter(f => f?.key).map(field => (
                <SettingField key={field.key} field={field.secret ? { ...field, placeholder: addon.configuredSecrets?.includes(field.key) ? t('Configured — enter a replacement') : field.placeholder } : field} value={values[field.key] ?? field.default} onChange={v => update(field.key, v)} onAction={action} />
              ))}
              {addon.qualityOptions?.length > 0 && <SettingField
                field={{
                  key: 'downloadQuality',
                  label: 'Preferred playback & download quality',
                  type: 'select',
                  options: addon.qualityOptions.map(q => ({ value: q.id, label: q.label || q.id })),
                }}
                value={addon.qualityOptions.some(q => q.id === values.downloadQuality)
                  ? values.downloadQuality
                  : (addon.qualityOptions.find(q => q.id === 'HI_RES_LOSSLESS')?.id ||
                      addon.qualityOptions.find(q => q.kind === 'lossless')?.id ||
                      addon.qualityOptions[0].id)}
                onChange={v => update('downloadQuality', v)}
              />}
              {addon.qualityOptions?.length > 0 && <p className="text-[11px] text-muted">
                Lokal requests the selected tier for playback and downloads. A Dolby tier needs native output and is not a guarantee that every song supports it; unsupported audio will be reported, not silently downgraded.
              </p>}
              {(addon.qualityOptions || []).map(quality => (quality.settings || []).map(field => <SettingField key={`${quality.id}:${field.key}`} field={{ ...field, label: `${quality.label}: ${field.label}`, help: field.description, type: field.type === 'boolean' ? 'toggle' : field.type, options: field.options?.map(o => typeof o === 'object' ? o : { value: o, label: o }) }} value={values.qualitySettings?.[quality.id]?.[field.key] ?? field.default} onChange={v => update('qualitySettings', { ...values.qualitySettings, [quality.id]: { ...values.qualitySettings?.[quality.id], [field.key]: v } })} />))}
              <button disabled={busy} onClick={save} className="rounded-lg bg-accent/20 px-3 py-2 text-xs text-accent disabled:opacity-40">{t("Save settings")}</button>
              {(addon.actions || []).map(item => <button key={item.action} disabled={busy} onClick={() => action(item.action)} className="ml-2 rounded-lg border border-border px-3 py-2 text-xs text-text">{t(item.label || item.action)}</button>)}
              {(addon.signedSession || addon.access?.kind === 'login') && <div className="space-y-2 border-t border-border pt-3">
                <p className="flex items-center gap-1.5 text-xs text-muted">{verified
                  ? <><CheckCircle2 size={13} className="text-accent" />{t('Verified access is active.')}</>
                  : addon.signedSession
                    ? t('This source needs a one-time browser verification before it can stream or download. A window opens; access is checked automatically when it closes.')
                    : t('Log in with the button above to stream and download from this source. Access is checked automatically when the login window closes.')}</p>
                {addon.signedSession && !verified && <button disabled={busy || !addon.enabled} onClick={verify} className="rounded-lg bg-accent/20 px-3 py-2 text-xs text-accent disabled:opacity-40">{t("Verify access")}</button>}
                {verified && <button disabled={busy} onClick={() => run(async () => { const result = await api.addonsPackages({ action: 'package.logout', key: addon.key }); setAuth({ authenticated: false }); onChanged(); return result })} className="text-xs text-muted hover:text-text">{t("Disconnect")}</button>}
              </div>}
              {!api.isElectron && auth?.open_auth_url && /^https:\/\//i.test(auth.open_auth_url) && <button onClick={() => api.openExternal(auth.open_auth_url)} className="text-xs text-accent underline">{t("Open verification / login page")}</button>}
              {form && <form onSubmit={e => { e.preventDefault(); action(form.submit_action, formInput, form.token) }} className="space-y-3 rounded-lg border border-border p-3">
                <p className="text-sm text-text">{form.title || 'Account details'}</p>{form.description && <p className="text-xs text-muted">{form.description}</p>}
                {form.fields.map(field => <SettingField key={field.key} field={{ ...field, secret: ['password', 'otp'].includes(field.type), options: field.options?.map(o => ({ value: o, label: o })) }} value={formInput[field.key] ?? field.default} onChange={v => setFormInput(current => ({ ...current, [field.key]: v }))} />)}
                <button disabled={busy} type="submit" className="rounded-lg bg-accent/20 px-3 py-2 text-xs text-accent">{t("Continue")}</button><button type="button" onClick={() => { setForm(null); setFormInput({}) }} className="ml-3 text-xs text-muted">{t("Cancel")}</button>
              </form>}
            </div>
          )}
        </div>
      )}
      {message && <p role="status" className="mt-2 text-xs text-muted">{message}</p>}
      {/credential vault/i.test(message) && (
        <div className="mt-2 flex items-center gap-2">
          {confirmReset ? (
            <>
              <span className="text-[11px] text-muted">{t('This removes saved addon logins and settings. Continue?')}</span>
              <button disabled={busy} onClick={async () => { if (await run(() => api.addonsPackages({ action: 'credentials.reset' }))) { setConfirmReset(false); setMessage(t('Saved logins were reset. Log in to your addons again.')); onChanged() } }} className="rounded-lg border border-red/40 px-2.5 py-1 text-[11px] text-red hover:bg-red/10">{t('Reset')}</button>
              <button disabled={busy} onClick={() => setConfirmReset(false)} className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted hover:text-text">{t('Cancel')}</button>
            </>
          ) : <button onClick={() => setConfirmReset(true)} className="rounded-lg border border-border px-2.5 py-1 text-[11px] text-muted hover:text-text">{t('Reset saved logins')}</button>}
        </div>
      )}
    </div>
  )
}

/**
 * A repository's name for people: the registry's own name, else where it
 * lives in the repository URL (owner/repository), not the raw
 * registry.json URL.
 */
export function repositoryLabel(repo) {
  let url
  try { url = new URL(repo?.url || '') } catch { return repo?.name || repo?.url || 'Repository' }
  const name = String(repo?.name || '').trim()
  if (name && name.toLowerCase() !== url.hostname.toLowerCase()) return name
  const parts = url.pathname.split('/').filter(Boolean)
  if (/^(raw\.githubusercontent\.com|github\.com)$/i.test(url.hostname) && parts.length >= 2) return `${parts[0]}/${parts[1]}`
  if (/\.github\.io$/i.test(url.hostname)) return `${url.hostname.split('.')[0]}${parts[0] && !/\.json$/i.test(parts[0]) ? `/${parts[0]}` : ''}`
  const folders = parts.filter(part => !/\.json$/i.test(part))
  return [url.hostname.replace(/^www\./, ''), ...folders.slice(0, 2)].join('/')
}

function RepositoryBrowser({ onChanged }) {
  const { t } = useTranslation()
  // Empty: the official repository is already listed below.
  const [url, setUrl] = useState('')
  const [installKey, setInstallKey] = useState('')
  const [repos, setRepos] = useState([])
  const [entries, setEntries] = useState([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const request = action => api.addonsPackages(action)
  const load = async () => {
    const [repositories, catalogue] = await Promise.all([request({ action: 'repositories' }), request({ action: 'catalogue' })])
    if (Array.isArray(repositories)) setRepos(repositories)
    if (Array.isArray(catalogue)) setEntries(catalogue)
  }
  useEffect(() => { load().catch(e => setMessage(t(e.message))) }, [])
  const run = async action => {
    setBusy(true); setMessage('')
    try { const result = await action(); if (result?.error) throw new Error(result.error); await load(); onChanged() }
    catch (error) { setMessage(t(error.message)) }
    finally { setBusy(false) }
  }
  const upload = event => {
    const file = event.target.files?.[0]; event.target.value = ''
    if (!file) return
    run(async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error('Addon packages must be smaller than 32 MB')
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the package')); reader.readAsDataURL(file) })
      return request({ action: 'package.upload', data })
    })
  }
  return <div className="space-y-3">
    <p className="text-sm font-medium text-text">{t("Mornye repositories")}</p>
    <p className="text-xs leading-relaxed text-muted">{t("Add a repository to browse its downloadable sources, or install an extension package. Installed sources appear in search and can play or save songs to your library.")}</p>
    <div className="flex gap-2"><input aria-label={t("Repository registry URL")} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…/registry.json" className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-text" /><button disabled={busy || !url.trim()} onClick={() => run(async () => { const result = await request({ action: 'repository.add', url: url.trim() }); if (!result?.error) setUrl(''); return result })} className="rounded-lg bg-accent/20 px-3 py-2 text-xs text-accent disabled:opacity-40">{t("Add repository")}</button></div>
    <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted ${busy ? 'pointer-events-none opacity-40' : ''}`}><Upload size={13} />{t('Install package file')}<input type="file" accept=".sflx,.spotiflac-ext" disabled={busy} onChange={upload} className="hidden" /></label>
    {repos.map(repo => <div key={repo.id} className="flex items-start gap-3 rounded-lg border border-border p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm text-text" title={repo.url}>{repositoryLabel(repo)}</p><p className="mt-0.5 truncate text-[10px] text-muted/70" title={repo.url}>{repo.url}</p><p className="mt-1 text-[11px] text-muted">{repo.error ? t(repo.error) : repo.refreshed_at ? t('Refreshed {date}', { date: new Date(repo.refreshed_at).toLocaleString() }) : t('Not refreshed')}</p></div><button disabled={busy} title={t("Refresh repository")} aria-label={t("Refresh repository")} onClick={() => run(() => request({ action: 'repository.refresh', id: repo.id }))} className="text-muted hover:text-accent"><RefreshCw size={14} /></button><button disabled={busy} title={t("Remove repository")} aria-label={t("Remove repository")} onClick={() => run(() => request({ action: 'repository.remove', id: repo.id }))} className="text-muted hover:text-red"><Trash2 size={14} /></button></div>)}
    {entries.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{entries.map(entry => <div key={`${entry.repositoryId}:${entry.id}`} className="rounded-xl border border-border bg-card/60 p-3"><div className="flex items-start justify-between gap-2"><p className="text-sm text-text">{entry.display_name || entry.id}<span className="ml-2 text-[11px] text-muted">v{entry.version}</span></p><button disabled={busy || !entry.compatible || entry.installed && !entry.updateAvailable} onClick={() => run(() => request({ action: 'package.install', repositoryId: entry.repositoryId, id: entry.id }))} className="rounded-lg bg-accent/20 px-3 py-1 text-xs text-accent disabled:opacity-40">{t(entry.updateAvailable ? 'Update' : entry.installed ? 'Installed' : 'Install')}</button></div>{entry.category === 'integration' && <p className="mt-1 text-[10px] uppercase tracking-wider text-accent/80">{t("Reads playlist links · for playlist sync")}</p>}<p className="mt-2 text-[11px] leading-relaxed text-muted">{entry.description}</p>{!entry.compatible && <p className="mt-1 text-xs text-muted">{t('Requires Mornye compatibility {version}', { version: entry.min_app_version })}</p>}</div>)}</div>}
    {busy && <p className="flex items-center gap-2 text-xs text-muted"><Loader2 size={13} className="animate-spin" />{t("Working…")}</p>}{message && <p role="alert" className="text-xs text-red">{t(message)}</p>}
  </div>
}

/** The Addons section. */
export default function AddonsSettings() {
  const { t } = useTranslation()
  const focusKey = useLocation().state?.addon || null
  // Last visit's list shows at once; the Settings category fades in once
  // the list is in (it used to appear empty for a frame first).
  const [addons, setAddons] = useState(() => peekCache('settings:addons') ?? null)
  usePageReady(addons !== null)
  const [url, setUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState(null) // { error?, text }

  // Only the latest request applies; a failed one keeps the list shown.
  const loadRequest = useRef(0)
  const load = () => {
    const request = ++loadRequest.current
    const failed = () => { if (request === loadRequest.current) setAddons(prev => prev ?? []) }
    return Promise.resolve(api.addonsList?.()).then(list => {
      if (request !== loadRequest.current) return
      if (!Array.isArray(list)) return failed()
      writeCache('settings:addons', list)
      setAddons(list)
    }).catch(failed)
  }
  useEffect(() => { load() }, [])
  const onChanged = () => { load(); changed() }

  const install = async () => {
    if (!url.trim()) return
    setInstalling(true)
    setMessage(null)
    const result = await Promise.resolve(api.addonsInstall(url.trim(), { signingKey: installKey })).catch(e => ({ error: e.message }))
    setInstalling(false)
    if (result?.error) { setMessage({ error: true, text: t(result.error) }); return }
    setMessage({ text: t('{name} installed. It\'s now a source above the online results in search.', { name: result.name }) })
    setUrl('')
    setInstallKey('')
    onChanged()
  }

  return (
    <div className="space-y-4">
      <RepositoryBrowser onChanged={onChanged} />
      <div className="space-y-3 border-t border-border pt-4"><p className="text-sm font-medium text-text">{t("HTTP addons")}</p>
      <p className="!mt-1.5 text-xs leading-relaxed text-muted">
        {t("Add online sources by pasting an addon's manifest URL (addons made for Eclipse Music work). An addon's results show up as a source next to YouTube Music and SoundCloud in search, and its songs can be played, added to playlists and saved to your library.")}
      </p>
      <div className="flex items-start gap-3 rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-3">
        <AlertTriangle size={15} className="mt-0.5 flex-shrink-0 text-yellow-300" />
        <p className="text-[11px] leading-relaxed text-text/80">
          {t("Addons are made and run by third parties. Lokal doesn't host, check or vouch for any of them, and you're responsible for the ones you add. Only add addons you trust and are allowed to use where you live. An addon URL can contain a personal token: don't share it.")}
        </p>
      </div>
      <div className="flex gap-2">
        <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && install()}
          placeholder="https://example.com/…/manifest.json" spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent/50 placeholder:text-muted" />
        <button onClick={install} disabled={installing || !url.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[rgb(var(--bg-rgb))] transition-colors hover:bg-accent/80 disabled:opacity-40">
          {installing && <Loader2 size={12} className="animate-spin" />} {t('Install')}
        </button>
      </div>
      <input aria-label={t('HMAC signing key (optional)')} type="password" autoComplete="new-password" spellCheck={false} value={installKey} onChange={e => setInstallKey(e.target.value)}
        placeholder={t('Optional HMAC signing key for this add-on')} className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-text outline-none focus:border-accent/50" />
      {message && <p className={`text-xs ${message.error ? 'text-red' : 'text-accent'}`}>{t(message.text)}</p>}
      </div>
      {addons === null ? null : addons.length === 0 ? (
        <p className="text-xs text-muted">{t("No addons installed.")}</p>
      ) : (
        <div className="space-y-3">
          {addons.map(addon => <AddonCard key={addon.key} addon={addon} onChanged={onChanged} focused={addon.key === focusKey} />)}
        </div>
      )}
    </div>
  )
}
