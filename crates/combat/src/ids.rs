//! Every id the rules use, as a `#[repr(u8)]` enum whose discriminant is its wire byte.

/// A field-less enum whose discriminants are its wire bytes: behavior bodies, account bytes,
/// the wasm JSON and trace lines all carry the `u8`. `from_u8` is the only way in from a byte, so
/// an unknown value is rejected where it is read.
macro_rules! byte_enum {
    ($(#[$meta:meta])* $name:ident { $(#[$fmeta:meta])* $first:ident = $first_value:literal $(, $(#[$vmeta:meta])* $variant:ident = $value:literal)* $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        #[repr(u8)]
        pub enum $name {
            $(#[$fmeta])* $first = $first_value,
            $($(#[$vmeta])* $variant = $value,)*
        }

        impl $name {
            pub const ALL: &'static [Self] = &[Self::$first $(, Self::$variant)*];

            pub const fn from_u8(byte: u8) -> Option<Self> {
                match byte {
                    $first_value => Some(Self::$first),
                    $($value => Some(Self::$variant),)*
                    _ => None,
                }
            }

            pub const fn id(self) -> u8 {
                self as u8
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::$first
            }
        }

        /// Writes the wire byte, as trace lines carry it.
        impl core::fmt::Display for $name {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                write!(f, "{}", *self as u8)
            }
        }

        impl From<$name> for u8 {
            fn from(value: $name) -> u8 {
                value as u8
            }
        }

        impl TryFrom<u8> for $name {
            type Error = u8;

            fn try_from(byte: u8) -> Result<Self, u8> {
                Self::from_u8(byte).ok_or(byte)
            }
        }
    };
}

byte_enum! {
    /// Whether a movement keeps stepping after one of its element's actions executes.
    Stop { Continue = 0, OnAction = 1 }
}

byte_enum! {
    MoveKind { Approach = 0, Flee = 1, FlankLeft = 2, FlankRight = 3 }
}

byte_enum! {
    Extremum { Lowest = 0, Highest = 1 }
}

byte_enum! {
    Stat { Distance = 0, Hp = 1, Atk = 2 }
}

byte_enum! {
    /// The side a target rule picks from, seen from the actor.
    TargetSide {
        /// A living unit of the other side.
        Enemy = 0,
        /// Another living unit on the actor's side, never the actor.
        Ally = 1,
    }
}

byte_enum! {
    Verb { Attack = 0, Cast = 1 }
}

byte_enum! {
    /// A battle side. Side A is the army that was already queued.
    Side { A = 0, B = 1 }
}

impl Side {
    pub const fn other(self) -> Self {
        match self {
            Side::A => Side::B,
            Side::B => Side::A,
        }
    }
}

byte_enum! {
    /// A catalog race. Each race numbers its own unit kinds from 0.
    Race { Ashborn = 0, Rootborn = 1, Deeplings = 2 }
}

byte_enum! {
    /// Ashborn unit kinds. On a snapshot the kind is the `u8`, read with the race.
    AshbornKind { Guard = 0, Skirmisher = 1, Archer = 2, Vanguard = 3, Warden = 4 }
}

byte_enum! {
    /// Rootborn unit kinds: fewer and costlier than Ashborn's.
    RootbornKind { Thornling = 0, Briarsling = 1, Elderoak = 2 }
}

byte_enum! {
    /// Deeplings unit kinds: costs between Ashborn's and Rootborn's.
    DeeplingsKind { Clawling = 0, Eelsnare = 1, Spineshot = 2, Tidecaller = 3 }
}

byte_enum! {
    /// What a cast does to each unit it lands on, after its damage.
    Effect {
        None = 0,
        /// Moves the unit `power` tiles straight away from the caster.
        Push = 1,
        /// Multiplies the unit's movement points by `1 + power` for `rounds` rounds.
        Sprint = 2,
        /// Adds `power` to the unit's attack range for `rounds` rounds.
        Reach = 3,
        /// For `rounds` rounds every movement the unit makes approaches the caster.
        Taunt = 4,
        /// Restores up to `power` HP, never above the unit's starting HP.
        Heal = 5,
    }
}

impl Effect {
    /// Effects that stay on a unit as a status until their rounds run out.
    pub const fn lasts(self) -> bool {
        matches!(self, Effect::Sprint | Effect::Reach | Effect::Taunt)
    }
}

byte_enum! {
    /// Who a cast may pick.
    Aim {
        /// The side the behavior action names.
        Chosen = 0,
        Foe = 1,
        /// Any living unit on the caster's side, the caster included.
        Ally = 2,
        /// The caster only. Written `self` in the catalog.
        Caster = 3,
    }
}
