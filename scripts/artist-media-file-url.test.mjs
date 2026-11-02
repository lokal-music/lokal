import test from 'node:test'
import assert from 'node:assert/strict'
import { artistMediaFileURL } from '../src/artistMediaFileURL.mjs'

test('desktop Windows paths become valid local file URLs (not escaped backslash URLs)', () => {
  const logo = String.raw`C:\Users\Cheick\Lokal Data\artist #1.png`
  const motion = String.raw`D:\Lokal\cache\motion\clip.mp4`
  assert.equal(artistMediaFileURL(logo), 'file:///C:/Users/Cheick/Lokal%20Data/artist%20%231.png')
  assert.equal(artistMediaFileURL(motion), 'file:///D:/Lokal/cache/motion/clip.mp4')
  assert.equal(new URL(artistMediaFileURL(logo)).pathname, '/C:/Users/Cheick/Lokal%20Data/artist%20%231.png')
})

test('artist media file URLs also support POSIX and UNC paths and reject malformed input', () => {
  assert.equal(artistMediaFileURL('/home/user/Lokal/motion clip.mp4'),
    'file:///home/user/Lokal/motion%20clip.mp4')
  assert.equal(artistMediaFileURL(String.raw`\\server\music\artist.png`), 'file://server/music/artist.png')
  assert.equal(artistMediaFileURL('../other-artist.png'), null)
  assert.equal(artistMediaFileURL(''), null)
  assert.equal(artistMediaFileURL(null), null)
})
