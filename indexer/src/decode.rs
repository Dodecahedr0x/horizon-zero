//! Anchor account decoder for Horizon Zero.
//!
//! Layouts match `programs/horizon-zero/src/state.rs`. The 8-byte discriminator
//! is `SHA-256("account:<Name>")[..8]`.

use carbon_core::account::{AccountDecoder, DecodedAccount};
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;

pub const PROGRAM_ID: &str = "zeroDcScmnx7TSvWvnKBa81Gcq34T1QSRWH182YdqRg";

pub(crate) const BEHAVIOR_LEN: usize = 119;
pub(crate) const BATTLEGROUND_LEN: usize = 576;
pub(crate) const ARMY_LEN: usize = 1360;
/// Only the current layout (with `opened_at`) is read. The 2147-byte layout before it is not: the
/// program writes only 2155-byte battles, and a local stack resets its ledger.
pub(crate) const BATTLE_LEN: usize = 2155;
const BODY_CAP: usize = 77;
const ARMY_UNIT: usize = 128;
const BATTLE_UNIT: usize = 96;
const ARMY_COL: usize = 34 + BODY_CAP;
const BATTLE_COL: usize = 2 + BODY_CAP;
const MAX_UNITS: usize = 10;
const ARMY_UNITS: usize = 78;
const ARMY_STATUS: usize = ARMY_UNITS + ARMY_UNIT * MAX_UNITS;
const BATTLE_UNITS_A: usize = 188;
const BATTLE_UNITS_B: usize = BATTLE_UNITS_A + BATTLE_UNIT * MAX_UNITS;
pub(crate) const BATTLE_STATUS: usize = BATTLE_UNITS_B + BATTLE_UNIT * MAX_UNITS;
pub(crate) const BATTLE_OUTCOME: usize = BATTLE_STATUS + 1 + 32;
const BATTLE_FEE_BPS: usize = BATTLE_OUTCOME + 3;
const BATTLE_OPENED_AT: usize = BATTLE_FEE_BPS + 2;

const MOVE_KINDS: [&str; 4] = ["Approach", "Flee", "Flank left", "Flank right"];
const EXTREMA: [&str; 2] = ["Lowest", "Highest"];
const STATS: [&str; 3] = ["Distance", "HP", "ATK"];
const VERBS: [&str; 2] = ["Attack", "Cast"];
const SIDES: [&str; 2] = ["Enemy", "Ally"];

const MARCH: &[u8] = &[1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
const CHARGE: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
const KITE: &[u8] = &[2, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0];
const FLANK_LEFT: &[u8] = &[1, 1, 2, 0, 0, 0, 0, 1, 0, 1, 2, 0];
const FLANK_RIGHT: &[u8] = &[1, 1, 3, 0, 0, 0, 0, 1, 0, 1, 2, 0];
const MARCH_CAST: &[u8] = &[1, 1, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0];
const CHARGE_CAST: &[u8] = &[1, 1, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0];
const KITE_CAST: &[u8] = &[2, 1, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0];
const FLANK_LEFT_CAST: &[u8] = &[1, 1, 2, 0, 0, 0, 0, 2, 1, 1, 2, 0, 0, 1, 2, 0];
const FLANK_RIGHT_CAST: &[u8] = &[1, 1, 3, 0, 0, 0, 0, 2, 1, 1, 2, 0, 0, 1, 2, 0];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BehaviorAccount {
    pub creator: String,
    pub body: Vec<u8>,
    pub element_count: u16,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmyUnit {
    pub kind: u8,
    pub behavior: String,
    pub body: Vec<u8>,
    pub col: u8,
    pub row: u8,
    pub cost: u16,
    pub hp: u8,
    pub atk: u8,
    pub range: u8,
    pub speed: u8,
    pub cast_damage: u8,
    pub cast_range: u8,
    pub cast_aoe: u8,
    pub cast_effect: u8,
    pub cast_aim: u8,
    pub cast_power: u8,
    pub cast_rounds: u8,
    pub cast_cooldown: u8,
    pub actions: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArmyAccount {
    pub owner: String,
    pub battleground: String,
    pub race: u8,
    pub index: u32,
    pub status: u8,
    pub units: Vec<ArmyUnit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BattlegroundAccount {
    pub battleground_id: u8,
    pub budget: u16,
    pub stake: u64,
    pub cols: u8,
    pub rows: u8,
    pub zone_depth: u8,
    pub queue: Vec<String>,
    pub match_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BattleUnit {
    pub kind: u8,
    pub body: Vec<u8>,
    pub col: u8,
    pub row: u8,
    pub cost: u16,
    pub hp: u8,
    pub atk: u8,
    pub range: u8,
    pub speed: u8,
    pub cast_damage: u8,
    pub cast_range: u8,
    pub cast_aoe: u8,
    pub cast_effect: u8,
    pub cast_aim: u8,
    pub cast_power: u8,
    pub cast_rounds: u8,
    pub cast_cooldown: u8,
    pub actions: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BattleAccount {
    pub battleground: String,
    pub army_a: String,
    pub army_b: String,
    pub player_a: String,
    pub player_b: String,
    pub stake: u64,
    pub seq: u64,
    pub cols: u8,
    pub rows: u8,
    pub units_a: Vec<BattleUnit>,
    pub units_b: Vec<BattleUnit>,
    pub status: u8,
    pub seed: String,
    pub outcome: u8,
    pub race_a: u8,
    pub race_b: u8,
    pub fee_bps: u16,
    /// Clock `unix_timestamp` when `lock_army` opened the battle; `cancel_match` waits from it.
    pub opened_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HorizonAccount {
    Behavior(BehaviorAccount),
    Battleground(BattlegroundAccount),
    Army(ArmyAccount),
    Battle(BattleAccount),
}

pub struct HorizonDecoder;

impl<'a> AccountDecoder<'a> for HorizonDecoder {
    type AccountType = HorizonAccount;

    fn decode_account(
        &self,
        account: &'a solana_account::Account,
    ) -> Option<DecodedAccount<HorizonAccount>> {
        let data = decode_account_data(&account.data)?;
        Some(DecodedAccount {
            lamports: account.lamports,
            data,
            owner: account.owner,
            executable: account.executable,
            rent_epoch: account.rent_epoch,
        })
    }
}

pub fn decode_account_data(data: &[u8]) -> Option<HorizonAccount> {
    if data.len() < 8 {
        return None;
    }
    let head: [u8; 8] = data[..8].try_into().ok()?;
    if head == discriminator("Behavior") && data.len() == BEHAVIOR_LEN {
        return decode_behavior(data).map(HorizonAccount::Behavior);
    }
    if head == discriminator("Battleground") && data.len() == BATTLEGROUND_LEN {
        return decode_battleground(data).map(HorizonAccount::Battleground);
    }
    if head == discriminator("Army") && data.len() == ARMY_LEN {
        return decode_army(data).map(HorizonAccount::Army);
    }
    if head == discriminator("Battle") && data.len() == BATTLE_LEN {
        return decode_battle(data).map(HorizonAccount::Battle);
    }
    None
}

/// `HZ_MATCH_RESOLVED <battle> <outcome> <fee> <seed hex> <player_b>`, logged by `settle_match` as it
/// closes the battle: the battle, its outcome (1 A, 2 B, 3 draw), the fee in lamports and the seed
/// in lowercase hex, the form a decoded Battle's `seed` takes.
pub fn parse_resolved(line: &str) -> Option<(String, u8, u64, String)> {
    let mut words = line.split(' ');
    if words.next()? != "HZ_MATCH_RESOLVED" {
        return None;
    }
    let battle = words.next()?.parse::<Pubkey>().ok()?;
    let outcome = words.next()?.parse::<u8>().ok().filter(|outcome| (1..=3).contains(outcome))?;
    let fee = words.next()?.parse::<u64>().ok()?;
    let seed = words.next()?;
    if seed.len() != 64 || !seed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    words.next()?.parse::<Pubkey>().ok()?;
    if words.next().is_some() {
        return None;
    }
    Some((battle.to_string(), outcome, fee, seed.to_ascii_lowercase()))
}

/// `HZ_MATCH_CANCELLED <battle>`, logged by `cancel_match` as it closes an Awaiting battle.
pub fn parse_cancelled(line: &str) -> Option<String> {
    let mut words = line.split(' ');
    if words.next()? != "HZ_MATCH_CANCELLED" {
        return None;
    }
    let battle = words.next()?.parse::<Pubkey>().ok()?;
    if words.next().is_some() {
        return None;
    }
    Some(battle.to_string())
}

/// The resolutions in one transaction's logs. A line counts only while `program` is the innermost
/// program invoked, so another program in the same transaction cannot log a resolution for it.
pub fn resolutions(logs: &[String], program: &str) -> Vec<(String, u8, u64, String)> {
    program_lines(logs, program).into_iter().filter_map(parse_resolved).collect()
}

/// The cancellations in one transaction's logs, under the same innermost-program rule.
pub fn cancellations(logs: &[String], program: &str) -> Vec<String> {
    program_lines(logs, program).into_iter().filter_map(parse_cancelled).collect()
}

/// The `Program log:` lines `program` wrote while it was the innermost program invoked.
fn program_lines<'a>(logs: &'a [String], program: &str) -> Vec<&'a str> {
    let mut stack: Vec<&str> = Vec::new();
    let mut found = Vec::new();
    for line in logs {
        if let Some(text) = line.strip_prefix("Program log: ") {
            if stack.last() == Some(&program) {
                found.push(text);
            }
            continue;
        }
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };
        let mut words = rest.split(' ');
        let (Some(id), Some(event)) = (words.next(), words.next()) else {
            continue;
        };
        match event {
            "invoke" => stack.push(id),
            "success" | "failed:" if stack.last() == Some(&id) => {
                stack.pop();
            }
            _ => {}
        }
    }
    found
}

/// Wallets this account contributes to the user index.
pub fn users_of(account: &HorizonAccount) -> Vec<String> {
    match account {
        HorizonAccount::Behavior(behavior) => vec![behavior.creator.clone()],
        HorizonAccount::Army(army) => vec![army.owner.clone()],
        HorizonAccount::Battle(battle) => vec![battle.player_a.clone(), battle.player_b.clone()],
        HorizonAccount::Battleground(_) => Vec::new(),
    }
}

#[cfg(test)]
pub(crate) fn fixture(name: &str, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    bytes[..8].copy_from_slice(&discriminator(name));
    bytes
}

fn discriminator(name: &str) -> [u8; 8] {
    let digest = Sha256::digest(format!("account:{name}").as_bytes());
    digest[..8].try_into().expect("sha256 prefix")
}

fn read_pubkey(data: &[u8], at: usize) -> String {
    let bytes: [u8; 32] = data[at..at + 32].try_into().expect("pubkey");
    Pubkey::new_from_array(bytes).to_string()
}

fn read_u16(data: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(data[at..at + 2].try_into().expect("u16"))
}

fn read_u32(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().expect("u32"))
}

fn read_u64(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().expect("u64"))
}

fn canonical_body(data: &[u8], len_at: usize, body_at: usize) -> Option<Vec<u8>> {
    let len = data[len_at] as usize;
    if len > BODY_CAP || body_at + len > data.len() {
        return None;
    }
    Some(data[body_at..body_at + len].to_vec())
}

fn decode_behavior(data: &[u8]) -> Option<BehaviorAccount> {
    let body = canonical_body(data, 40, 41)?;
    let (element_count, summary) = summarize(&body);
    Some(BehaviorAccount {
        creator: read_pubkey(data, 8),
        body,
        element_count,
        summary,
    })
}

fn decode_battleground(data: &[u8]) -> Option<BattlegroundAccount> {
    let queue_len = data[54] as usize;
    if queue_len > 16 {
        return None;
    }
    let mut queue = Vec::with_capacity(queue_len);
    for index in 0..queue_len {
        queue.push(read_pubkey(data, 55 + index * 32));
    }
    Some(BattlegroundAccount {
        battleground_id: data[40],
        budget: read_u16(data, 41),
        stake: read_u64(data, 43),
        cols: data[51],
        rows: data[52],
        zone_depth: data[53],
        queue,
        match_seq: read_u64(data, 567),
    })
}

fn decode_army(data: &[u8]) -> Option<ArmyAccount> {
    let count = data[77] as usize;
    if count > MAX_UNITS {
        return None;
    }
    let mut units = Vec::with_capacity(count);
    for index in 0..count {
        let start = 78 + index * ARMY_UNIT;
        let body = canonical_body(data, start + 33, start + 34)?;
        units.push(ArmyUnit {
            kind: data[start],
            behavior: read_pubkey(data, start + 1),
            body,
            col: data[start + ARMY_COL],
            row: data[start + ARMY_COL + 1],
            cost: read_u16(data, start + ARMY_COL + 2),
            hp: data[start + ARMY_COL + 4],
            atk: data[start + ARMY_COL + 5],
            range: data[start + ARMY_COL + 6],
            speed: data[start + ARMY_COL + 7],
            cast_damage: data[start + ARMY_COL + 8],
            cast_range: data[start + ARMY_COL + 9],
            cast_aoe: data[start + ARMY_COL + 10],
            cast_effect: data[start + ARMY_COL + 11],
            cast_aim: data[start + ARMY_COL + 12],
            cast_power: data[start + ARMY_COL + 13],
            cast_rounds: data[start + ARMY_COL + 14],
            cast_cooldown: data[start + ARMY_COL + 15],
            actions: data[start + ARMY_COL + 16],
        });
    }
    Some(ArmyAccount {
        owner: read_pubkey(data, 8),
        battleground: read_pubkey(data, 40),
        race: data[72],
        index: read_u32(data, 73),
        status: data[ARMY_STATUS],
        units,
    })
}

fn decode_battle(data: &[u8]) -> Option<BattleAccount> {
    let count_a = data[184] as usize;
    let count_b = data[185] as usize;
    if count_a > MAX_UNITS || count_b > MAX_UNITS {
        return None;
    }
    Some(BattleAccount {
        battleground: read_pubkey(data, 8),
        army_a: read_pubkey(data, 40),
        army_b: read_pubkey(data, 72),
        player_a: read_pubkey(data, 104),
        player_b: read_pubkey(data, 136),
        stake: read_u64(data, 168),
        seq: read_u64(data, 176),
        cols: data[186],
        rows: data[187],
        units_a: decode_battle_units(data, BATTLE_UNITS_A, count_a)?,
        units_b: decode_battle_units(data, BATTLE_UNITS_B, count_b)?,
        status: data[BATTLE_STATUS],
        seed: hex_encode(&data[BATTLE_STATUS + 1..BATTLE_OUTCOME]),
        outcome: data[BATTLE_OUTCOME],
        race_a: data[BATTLE_OUTCOME + 1],
        race_b: data[BATTLE_OUTCOME + 2],
        fee_bps: read_u16(data, BATTLE_FEE_BPS),
        opened_at: i64::from_le_bytes(data[BATTLE_OPENED_AT..BATTLE_OPENED_AT + 8].try_into().ok()?),
    })
}

fn decode_battle_units(data: &[u8], start: usize, count: usize) -> Option<Vec<BattleUnit>> {
    let mut units = Vec::with_capacity(count);
    for index in 0..count {
        let at = start + index * BATTLE_UNIT;
        let body = canonical_body(data, at + 1, at + 2)?;
        units.push(BattleUnit {
            kind: data[at],
            body,
            col: data[at + BATTLE_COL],
            row: data[at + BATTLE_COL + 1],
            cost: read_u16(data, at + BATTLE_COL + 2),
            hp: data[at + BATTLE_COL + 4],
            atk: data[at + BATTLE_COL + 5],
            range: data[at + BATTLE_COL + 6],
            speed: data[at + BATTLE_COL + 7],
            cast_damage: data[at + BATTLE_COL + 8],
            cast_range: data[at + BATTLE_COL + 9],
            cast_aoe: data[at + BATTLE_COL + 10],
            cast_effect: data[at + BATTLE_COL + 11],
            cast_aim: data[at + BATTLE_COL + 12],
            cast_power: data[at + BATTLE_COL + 13],
            cast_rounds: data[at + BATTLE_COL + 14],
            cast_cooldown: data[at + BATTLE_COL + 15],
            actions: data[at + BATTLE_COL + 16],
        });
    }
    Some(units)
}

fn summarize(body: &[u8]) -> (u16, String) {
    let Some(elements) = parse_behavior(body) else {
        return (0, "unparsed".to_string());
    };
    let count = elements.len() as u16;
    let label = if count == 1 { "element" } else { "elements" };
    (count, format!("{count} {label}: {}", describe(&elements)))
}

struct Movement {
    kind: u8,
    extremum: u8,
    stat: u8,
    side: u8,
    stop: u8,
}

struct Action {
    verb: u8,
    extremum: u8,
    stat: u8,
    side: u8,
}

struct Element {
    movement: Option<Movement>,
    actions: Vec<Action>,
}

fn parse_behavior(body: &[u8]) -> Option<Vec<Element>> {
    if body.is_empty() || body.len() > BODY_CAP {
        return None;
    }
    let mut index = 0;
    let count = *body.get(index)?;
    index += 1;
    if count == 0 || count > 4 {
        return None;
    }
    let mut elements = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let present = *body.get(index)?;
        index += 1;
        if present > 1 {
            return None;
        }
        let movement = if present == 1 {
            let kind = *body.get(index)?;
            let extremum = *body.get(index + 1)?;
            let stat = *body.get(index + 2)?;
            let side = *body.get(index + 3)?;
            let stop = *body.get(index + 4)?;
            index += 5;
            if kind > 3 || extremum > 1 || stat > 2 || side > 1 || stop > 1 {
                return None;
            }
            Some(Movement {
                kind,
                extremum,
                stat,
                side,
                stop,
            })
        } else {
            None
        };
        let action_count = *body.get(index)?;
        index += 1;
        if action_count > 3 {
            return None;
        }
        let mut actions = Vec::with_capacity(action_count as usize);
        for _ in 0..action_count {
            let verb = *body.get(index)?;
            let extremum = *body.get(index + 1)?;
            let stat = *body.get(index + 2)?;
            let side = *body.get(index + 3)?;
            index += 4;
            if verb > 1 || extremum > 1 || stat > 2 || side > 1 {
                return None;
            }
            actions.push(Action {
                verb,
                extremum,
                stat,
                side,
            });
        }
        elements.push(Element { movement, actions });
    }
    if index == body.len() {
        Some(elements)
    } else {
        None
    }
}

fn describe(elements: &[Element]) -> String {
    if let Some(name) = standard_name(elements) {
        return name.to_string();
    }
    if elements.is_empty() {
        return "Empty".to_string();
    }
    elements
        .iter()
        .map(describe_element)
        .collect::<Vec<_>>()
        .join(" · ")
}

fn standard_name(elements: &[Element]) -> Option<&'static str> {
    let body = encode_elements(elements)?;
    match body.as_slice() {
        MARCH => Some("March"),
        CHARGE => Some("Charge"),
        KITE => Some("Kite"),
        FLANK_LEFT => Some("Flank left"),
        FLANK_RIGHT => Some("Flank right"),
        MARCH_CAST => Some("March cast"),
        CHARGE_CAST => Some("Charge cast"),
        KITE_CAST => Some("Kite cast"),
        FLANK_LEFT_CAST => Some("Flank left cast"),
        FLANK_RIGHT_CAST => Some("Flank right cast"),
        _ => None,
    }
}

fn encode_elements(elements: &[Element]) -> Option<Vec<u8>> {
    if elements.is_empty() || elements.len() > 4 {
        return None;
    }
    let mut out = vec![elements.len() as u8];
    for element in elements {
        if element.actions.len() > 3 {
            return None;
        }
        if let Some(movement) = &element.movement {
            out.extend([
                1,
                movement.kind,
                movement.extremum,
                movement.stat,
                movement.side,
                movement.stop,
            ]);
        } else {
            out.push(0);
        }
        out.push(element.actions.len() as u8);
        for action in &element.actions {
            out.extend([action.verb, action.extremum, action.stat, action.side]);
        }
    }
    if out.len() > BODY_CAP {
        None
    } else {
        Some(out)
    }
}

fn describe_element(element: &Element) -> String {
    let mut parts = Vec::new();
    if let Some(movement) = &element.movement {
        let stop = if movement.stop == 1 {
            ", Stop if an action triggers"
        } else {
            ""
        };
        parts.push(format!(
            "{} {} {} {}{}",
            MOVE_KINDS[movement.kind as usize],
            EXTREMA[movement.extremum as usize],
            STATS[movement.stat as usize],
            SIDES[movement.side as usize],
            stop,
        ));
    }
    for action in &element.actions {
        parts.push(format!(
            "{} {} {} {}",
            VERBS[action.verb as usize],
            EXTREMA[action.extremum as usize],
            STATS[action.stat as usize],
            SIDES[action.side as usize],
        ));
    }
    if parts.is_empty() {
        "Wait".to_string()
    } else {
        parts.join(", ")
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pubkey(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn decodes_behavior_battle_and_users() {
        let creator = pubkey(7);
        let owner = pubkey(8);
        let player_a = pubkey(3);
        let player_b = pubkey(4);

        let mut behavior = fixture("Behavior", BEHAVIOR_LEN);
        behavior[8..40].copy_from_slice(creator.as_ref());
        behavior[40] = MARCH.len() as u8;
        behavior[41..41 + MARCH.len()].copy_from_slice(MARCH);
        let decoded = decode_account_data(&behavior).expect("behavior");
        let HorizonAccount::Behavior(behavior) = decoded else {
            panic!("expected behavior");
        };
        assert_eq!(behavior.creator, creator.to_string());
        assert_eq!(behavior.body, MARCH);
        assert_eq!(behavior.element_count, 1);
        assert_eq!(behavior.summary, "1 element: March");
        assert_eq!(
            users_of(&HorizonAccount::Behavior(behavior)),
            vec![creator.to_string()]
        );

        let mut army = fixture("Army", ARMY_LEN);
        army[8..40].copy_from_slice(owner.as_ref());
        army[40..72].copy_from_slice(pubkey(9).as_ref());
        army[72] = 0;
        army[73..77].copy_from_slice(&4u32.to_le_bytes());
        army[77] = 1;
        army[78] = 2;
        army[79..111].copy_from_slice(pubkey(6).as_ref());
        army[111] = MARCH.len() as u8;
        army[112..112 + MARCH.len()].copy_from_slice(MARCH);
        army[78 + ARMY_COL] = 1;
        army[78 + ARMY_COL + 1] = 0;
        army[78 + ARMY_COL + 2..78 + ARMY_COL + 4].copy_from_slice(&3u16.to_le_bytes());
        army[78 + ARMY_COL + 4] = 3;
        army[78 + ARMY_COL + 5] = 2;
        army[78 + ARMY_COL + 6] = 3;
        army[78 + ARMY_COL + 7] = 2;
        army[78 + ARMY_COL + 8] = 2;
        army[78 + ARMY_COL + 9] = 4;
        army[ARMY_STATUS] = 2;
        let decoded = decode_account_data(&army).expect("army");
        let HorizonAccount::Army(army) = decoded else {
            panic!("expected army");
        };
        assert_eq!(army.owner, owner.to_string());
        assert_eq!(army.status, 2);
        assert_eq!(army.index, 4);
        assert_eq!(army.units.len(), 1);
        assert_eq!(army.units[0].kind, 2);
        assert_eq!(army.units[0].body, MARCH);
        assert_eq!(army.units[0].col, 1);
        assert_eq!(army.units[0].cost, 3);
        assert_eq!(army.units[0].hp, 3);
        assert_eq!(army.units[0].cast_damage, 2);
        assert_eq!(army.units[0].cast_range, 4);
        assert_eq!(
            users_of(&HorizonAccount::Army(army.clone())),
            vec![owner.to_string()]
        );

        let mut battle = fixture("Battle", BATTLE_LEN);
        battle[8..40].copy_from_slice(pubkey(9).as_ref());
        battle[40..72].copy_from_slice(pubkey(10).as_ref());
        battle[72..104].copy_from_slice(pubkey(11).as_ref());
        battle[104..136].copy_from_slice(player_a.as_ref());
        battle[136..168].copy_from_slice(player_b.as_ref());
        battle[168..176].copy_from_slice(&42u64.to_le_bytes());
        battle[176..184].copy_from_slice(&7u64.to_le_bytes());
        battle[184] = 1;
        battle[185] = 0;
        battle[186] = 8;
        battle[187] = 6;
        battle[188] = 0;
        battle[189] = MARCH.len() as u8;
        battle[190..190 + MARCH.len()].copy_from_slice(MARCH);
        battle[188 + BATTLE_COL] = 2;
        battle[188 + BATTLE_COL + 1] = 1;
        battle[188 + BATTLE_COL + 2..188 + BATTLE_COL + 4].copy_from_slice(&2u16.to_le_bytes());
        battle[188 + BATTLE_COL + 4] = 6;
        battle[188 + BATTLE_COL + 8] = 1;
        battle[188 + BATTLE_COL + 11] = 1;
        battle[188 + BATTLE_COL + 13] = 2;
        battle[188 + BATTLE_COL + 14] = 3;
        battle[188 + BATTLE_COL + 15] = 4;
        battle[188 + BATTLE_COL + 16] = 1;
        battle[BATTLE_STATUS] = 1;
        battle[BATTLE_STATUS + 1..BATTLE_OUTCOME].fill(9);
        battle[BATTLE_OUTCOME] = 3;
        battle[BATTLE_OUTCOME + 1] = 0;
        battle[BATTLE_OUTCOME + 2] = 0;
        let decoded = decode_account_data(&battle).expect("battle");
        let HorizonAccount::Battle(battle) = decoded else {
            panic!("expected battle");
        };
        assert_eq!(battle.player_a, player_a.to_string());
        assert_eq!(battle.player_b, player_b.to_string());
        assert_eq!(battle.stake, 42);
        assert_eq!(battle.seq, 7);
        assert_eq!(battle.cols, 8);
        assert_eq!(battle.rows, 6);
        assert_eq!(battle.status, 1);
        assert_eq!(battle.outcome, 3);
        assert_eq!(battle.seed, "09".repeat(32));
        assert_eq!(battle.units_a.len(), 1);
        assert_eq!(battle.units_a[0].body, MARCH);
        assert_eq!(battle.units_a[0].col, 2);
        assert_eq!(battle.units_a[0].row, 1);
        assert_eq!(battle.units_a[0].hp, 6);
        assert_eq!(battle.units_a[0].cast_effect, 1);
        assert_eq!(battle.units_a[0].cast_power, 2);
        assert_eq!(battle.units_a[0].cast_rounds, 3);
        assert_eq!(battle.units_a[0].cast_cooldown, 4);
        assert_eq!(battle.units_a[0].actions, 1);
        assert_eq!(battle.race_a, 0);
        assert_eq!(battle.race_b, 0);
        assert_eq!(
            users_of(&HorizonAccount::Battle(battle)),
            vec![player_a.to_string(), player_b.to_string()]
        );

        assert!(decode_account_data(&fixture("Config", 41)).is_none());
        assert!(decode_account_data(&fixture("Behavior", 10)).is_none());
    }

    #[test]
    fn battle_carries_its_fee_rate_and_open_time() {
        let mut battle = fixture("Battle", 2155);
        battle[2144..2146].copy_from_slice(&500u16.to_le_bytes());
        battle[2146..2154].copy_from_slice(&1_792_016_933i64.to_le_bytes());
        battle[2154] = 254;
        let HorizonAccount::Battle(battle) = decode_account_data(&battle).expect("battle") else {
            panic!("expected battle");
        };
        assert_eq!(battle.fee_bps, 500);
        assert_eq!(battle.opened_at, 1_792_016_933);
        assert_eq!(battle.status, 0);
        // The layouts before opened_at (2147) and before fee_bps (2145) no longer match.
        assert!(decode_account_data(&fixture("Battle", 2147)).is_none());
        assert!(decode_account_data(&fixture("Battle", 2145)).is_none());
    }

    #[test]
    fn cancelled_log_names_the_battle_and_only_the_program_s_own_line_counts() {
        let battle = pubkey(5).to_string();
        let forged = pubkey(7).to_string();
        let other = pubkey(9).to_string();
        assert_eq!(parse_cancelled(&format!("HZ_MATCH_CANCELLED {battle}")), Some(battle.clone()));
        for bad in [
            String::new(),
            "HZ_MATCH_CANCELLED".to_string(),
            "HZ_MATCH_CANCELLED nope".to_string(),
            format!("HZ_MATCH_CANCELLED {battle} extra"),
            format!("HZ_MATCH_RESOLVED {battle}"),
        ] {
            assert_eq!(parse_cancelled(&bad), None, "{bad}");
        }
        let program = PROGRAM_ID;
        let logs: Vec<String> = vec![
            format!("Program {program} invoke [1]"),
            format!("Program log: HZ_PLAYER {battle}"),
            format!("Program {other} invoke [2]"),
            format!("Program log: HZ_MATCH_CANCELLED {forged}"),
            format!("Program {other} success"),
            format!("Program log: HZ_MATCH_CANCELLED {battle}"),
            format!("Program {program} success"),
        ];
        assert_eq!(cancellations(&logs, program), vec![battle]);
        assert!(resolutions(&logs, program).is_empty());
    }

    #[test]
    fn players_config_outbox_and_old_pots_are_ignored() {
        // Player 68, Config 83, Outbox 49; a Pot was 8 + owner 32, battleground 32, budget 8, winnings 8,
        // segregate 1, fighting 2, bump 1 = 92.
        for (name, len) in [("Player", 68), ("Config", 83), ("Outbox", 49), ("Pot", 92)] {
            assert!(decode_account_data(&fixture(name, len)).is_none(), "{name} {len}");
        }
        // A Player-sized account under another discriminator is not read as anything either.
        assert!(decode_account_data(&fixture("Army", 68)).is_none());
    }

    #[test]
    fn resolved_log_gives_battle_outcome_and_fee() {
        let battle = pubkey(5).to_string();
        let player_b = pubkey(6).to_string();
        let seed = "ab".repeat(32);
        let line = format!("HZ_MATCH_RESOLVED {battle} 1 1000000 {seed} {player_b}");
        assert_eq!(parse_resolved(&line), Some((battle.clone(), 1, 1_000_000, seed.clone())));
        assert_eq!(parse_resolved(&format!("HZ_MATCH_RESOLVED {battle} 3 0 {seed} {player_b}")), Some((battle.clone(), 3, 0, seed.clone())));

        let upper = format!("HZ_MATCH_RESOLVED {battle} 1 1000000 {} {player_b}", seed.to_uppercase());
        assert_eq!(parse_resolved(&upper), Some((battle.clone(), 1, 1_000_000, seed.clone())));

        for bad in [
            String::new(),
            format!("HZ_MATCH_SEEDED {battle} {seed}"),
            format!("HZ_MATCH_RESOLVED {battle} 1 1000000 {seed}"),
            format!("HZ_MATCH_RESOLVED {battle} 1 1000000 {seed} {player_b} extra"),
            format!("HZ_MATCH_RESOLVED nope 1 1000000 {seed} {player_b}"),
            format!("HZ_MATCH_RESOLVED {battle} 0 1000000 {seed} {player_b}"),
            format!("HZ_MATCH_RESOLVED {battle} 4 1000000 {seed} {player_b}"),
            format!("HZ_MATCH_RESOLVED {battle} 1 -5 {seed} {player_b}"),
            format!("HZ_MATCH_RESOLVED {battle} 1 18446744073709551616 {seed} {player_b}"),
            format!("HZ_MATCH_RESOLVED {battle} 1 1000000 abcd {player_b}"),
            format!("HZ_MATCH_RESOLVED {battle} 1 1000000 {} {player_b}", "zz".repeat(32)),
            format!("HZ_MATCH_RESOLVED {battle} 1 1000000 {seed} nope"),
        ] {
            assert_eq!(parse_resolved(&bad), None, "{bad}");
        }
    }

    #[test]
    fn only_the_program_s_own_log_lines_count() {
        let program = PROGRAM_ID;
        let other = pubkey(9).to_string();
        let battle = pubkey(5).to_string();
        let forged = pubkey(7).to_string();
        let seed = "00".repeat(32);
        let player_b = pubkey(6).to_string();
        let logs: Vec<String> = vec![
            format!("Program {program} invoke [1]"),
            format!("Program {other} invoke [2]"),
            format!("Program log: HZ_MATCH_RESOLVED {forged} 2 9 {seed} {player_b}"),
            format!("Program {other} success"),
            format!("Program log: HZ_PLAYER {player_b}"),
            format!("Program log: HZ_MATCH_RESOLVED {battle} 2 750000 {seed} {player_b}"),
            format!("Program {program} consumed 1000 of 200000 compute units"),
            format!("Program {program} success"),
            format!("Program {other} invoke [1]"),
            format!("Program log: HZ_MATCH_RESOLVED {forged} 1 1 {seed} {player_b}"),
            format!("Program {other} failed: custom program error: 0x1"),
        ];
        assert_eq!(resolutions(&logs, program), vec![(battle, 2, 750_000, seed)]);
    }

    #[test]
    fn stop_flag_is_part_of_a_custom_summary() {
        let body = [1u8, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0];
        let (count, summary) = summarize(&body);
        assert_eq!(count, 1);
        assert_eq!(
            summary,
            "1 element: Approach Highest HP Enemy, Stop if an action triggers, Attack Lowest Distance Enemy"
        );
        assert!(parse_behavior(&[1, 1, 0, 0, 0, 2, 0]).is_none());
        assert!(parse_behavior(&[1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]).is_none());
        assert!(parse_behavior(&[1, 0, 1, 0, 0, 0, 2]).is_none());
        assert_eq!(summarize(MARCH_CAST).1, "1 element: March cast");
        assert_eq!(summarize(KITE).1, "2 elements: Kite");
    }
}
