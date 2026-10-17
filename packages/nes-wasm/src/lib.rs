//! wasm-bindgen wrapper around tetanes-core, shaped like `EmulatorCore` in `@neslink/core`.
//!
//! Frame and audio buffers are exposed as pointers into wasm memory so the
//! worker can read them without a copy per frame.

use tetanes_core::{
    control_deck::{Config, ControlDeck},
    input::{JoypadBtnState, Player},
    memory::RamState,
    prelude::{NesRegion, ResetKind},
    video::{Frame, VideoFilter},
};
use wasm_bindgen::prelude::*;

const PLAYERS: [Player; 2] = [Player::One, Player::Two];

#[wasm_bindgen]
pub struct Nes {
    deck: ControlDeck,
    frame: Box<[u8; Frame::SIZE]>,
    audio: Vec<f32>,
    state: Vec<u8>,
    sample_rate: f32,
    /// Rollback snapshots, kept inside wasm so saving one per frame costs no JS copy.
    slots: Vec<Vec<u8>>,
}

#[wasm_bindgen]
impl Nes {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Nes {
        let mut cfg = Config::default();
        // Netplay needs every machine to boot identically, so no random RAM.
        cfg.ram_state = RamState::AllZeros;
        // The worker paces frames at NTSC rate; PAL timing is not supported yet.
        cfg.region = NesRegion::Ntsc;
        // Save files are handled by the web app (IndexedDB), not by the core.
        cfg.sram_dir = None;
        // Straight palette colors. The default NTSC composite filter mutes and blurs them.
        cfg.filter = VideoFilter::Pixellate;
        cfg.clear_audio_on_clock = false;
        let mut deck = ControlDeck::with_config(cfg);
        deck.set_sample_rate(sample_rate);
        Nes {
            deck,
            // The filter only writes RGB, so alpha has to start opaque.
            frame: Box::new([0xFF; Frame::SIZE]),
            audio: Vec::new(),
            state: Vec::new(),
            sample_rate,
            slots: Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = loadRom)]
    pub fn load_rom(&mut self, name: &str, rom: &[u8]) -> Result<(), JsError> {
        let mut reader = rom;
        self.deck.load_rom(name, &mut reader)?;
        self.deck.clear_audio_samples();
        Ok(())
    }

    pub fn reset(&mut self) {
        self.deck.reset(ResetKind::Soft);
    }

    /// Runs one frame. `p1`/`p2` are button masks in NES shift-register order.
    #[wasm_bindgen(js_name = runFrame)]
    pub fn run_frame(&mut self, p1: u8, p2: u8) -> Result<(), JsError> {
        for (player, mask) in PLAYERS.into_iter().zip([p1, p2]) {
            self.deck.joypad_mut(player).buttons = JoypadBtnState::from_bits_truncate(mask.into());
        }
        // At the default 1x speed one call is exactly one NES frame.
        let _ = self.deck.clock_frame()?;
        Ok(())
    }

    /// Renders the last frame as RGBA into an internal buffer and returns its address.
    #[wasm_bindgen(js_name = framePtr)]
    pub fn frame_ptr(&mut self) -> *const u8 {
        self.deck.frame_buffer_into(&mut self.frame);
        self.frame.as_ptr()
    }

    /// Moves pending mono samples into an internal buffer; returns how many there are.
    /// Read them from [`Nes::audio_ptr`] before the next call.
    #[wasm_bindgen(js_name = drainAudio)]
    pub fn drain_audio(&mut self) -> usize {
        self.audio.clear();
        self.audio.extend_from_slice(self.deck.audio_samples());
        self.deck.clear_audio_samples();
        self.audio.len()
    }

    #[wasm_bindgen(js_name = audioPtr)]
    pub fn audio_ptr(&self) -> *const f32 {
        self.audio.as_ptr()
    }

    /// Serializes the console into an internal buffer; returns its length.
    /// Read it from [`Nes::state_ptr`]. Uncompressed, so it is fast enough for rollback.
    #[wasm_bindgen(js_name = saveState)]
    pub fn save_state(&mut self) -> Result<usize, JsError> {
        let len = self.deck.serialized_state_len()?;
        self.state.resize(len, 0);
        Ok(self.deck.serialize_state_into(&mut self.state)?)
    }

    #[wasm_bindgen(js_name = statePtr)]
    pub fn state_ptr(&self) -> *const u8 {
        self.state.as_ptr()
    }

    /// FNV-1a hash of the 2KB work RAM, for netplay desync checks. Unlike the full
    /// save state it does not depend on the host audio sample rate.
    #[wasm_bindgen(js_name = wramHash)]
    pub fn wram_hash(&self) -> u32 {
        self.deck.wram().iter().fold(0x811c_9dc5, |hash, &byte| {
            (hash ^ u32::from(byte)).wrapping_mul(0x0100_0193)
        })
    }

    /// Saves the console into rollback slot `slot` (slots grow as needed).
    #[wasm_bindgen(js_name = saveSlot)]
    pub fn save_slot(&mut self, slot: usize) -> Result<(), JsError> {
        if self.slots.len() <= slot {
            self.slots.resize_with(slot + 1, Vec::new);
        }
        let len = self.deck.serialized_state_len()?;
        let buf = &mut self.slots[slot];
        // Same size for the life of a cart, so after the first save this never reallocates.
        buf.resize(len, 0);
        self.deck.serialize_state_into(buf)?;
        Ok(())
    }

    /// Restores rollback slot `slot`, saved earlier on this machine by [`Nes::save_slot`].
    #[wasm_bindgen(js_name = loadSlot)]
    pub fn load_slot(&mut self, slot: usize) -> Result<(), JsError> {
        let buf = self.slots.get(slot).filter(|buf| !buf.is_empty()).ok_or_else(|| JsError::new("Empty rollback slot"))?;
        self.deck.deserialize_state(buf)?;
        Ok(())
    }

    /// Address and length of rollback slot `slot`, to copy out (e.g. as a spectator snapshot).
    #[wasm_bindgen(js_name = slotPtr)]
    pub fn slot_ptr(&self, slot: usize) -> *const u8 {
        self.slots.get(slot).map_or(std::ptr::null(), |buf| buf.as_ptr())
    }

    #[wasm_bindgen(js_name = slotLen)]
    pub fn slot_len(&self, slot: usize) -> usize {
        self.slots.get(slot).map_or(0, Vec::len)
    }

    #[wasm_bindgen(js_name = loadState)]
    pub fn load_state(&mut self, state: &[u8]) -> Result<(), JsError> {
        self.deck.deserialize_state(state)?;
        // The state carries the APU of the machine that saved it, including its
        // output sample rate; a netplay snapshot may come from another machine.
        self.deck.set_sample_rate(self.sample_rate);
        self.deck.clear_audio_samples();
        Ok(())
    }
}
