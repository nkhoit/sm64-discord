// Builds a save file the relay accepts: sm64coopdx's 512-byte EEPROM image (src/game/save_file.h),
// with save file A marked as existing, `seed` encoded in its star flags so saves can be told apart,
// and the first copies of file A and the menu data signed like the game signs them.
function makeSave(seed, { littleEndian = false } = {}) {
  const save = new Uint8Array(512);
  const sign = (offset, size, magic) => {
    const sig = offset + size - 4;
    save[sig + (littleEndian ? 1 : 0)] = magic >> 8;
    save[sig + (littleEndian ? 0 : 1)] = magic & 0xff;
    let sum = 0;
    for (let i = 0; i < size - 2; i++) { sum = (sum + save[offset + i]) & 0xffff; }
    save[sig + (littleEndian ? 3 : 2)] = sum >> 8;
    save[sig + (littleEndian ? 2 : 3)] = sum & 0xff;
  };
  save[littleEndian ? 8 : 11] = 1; // flags: SAVE_FLAG_FILE_EXISTS
  save[12] = seed & 0x7f; // courseStars[0..2]
  save[13] = (seed >> 7) & 0x7f;
  save[14] = (seed >> 14) & 0x7f;
  sign(0, 56, 0x4441); // files[0][0]
  sign(448, 32, 0x4849); // menuData[0]
  return save;
}

module.exports = { makeSave };
