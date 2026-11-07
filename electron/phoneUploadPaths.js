// This reserved directory is private transfer custody, never a library source.
const PRIVATE_PHONE_UPLOAD_DIRECTORY = '.lokal-phone-upload-incoming'
function isPrivatePhoneUploadPath(file) {
  return typeof file === 'string' && file.split(/[\\/]/)
    .some(part => part.toLowerCase() === PRIVATE_PHONE_UPLOAD_DIRECTORY)
}
module.exports = { PRIVATE_PHONE_UPLOAD_DIRECTORY, isPrivatePhoneUploadPath }
