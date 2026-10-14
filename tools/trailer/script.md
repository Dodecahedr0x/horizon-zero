---
model: dreamina-seedance-2-5-260628
ratio: 16:9
resolution: 720p
generate_audio: true
watermark: false
image1: units/ashborn/guard
image2: units/ashborn/skirmisher
image3: units/ashborn/archer
image4: units/ashborn/vanguard
image5: units/ashborn/warden
image6: units/rootborn/thornling
image7: units/rootborn/briarsling
image8: units/rootborn/elderoak
image9: board/tile
image10: board/rubble
image11: units/deeplings/clawling
image12: units/deeplings/eelsnare
image13: units/deeplings/spineshot
image14: units/deeplings/tidecaller
style: Cinematic game trailer. Art Nouveau frontier wargame aesthetic, painted forms, sinuous organic lines. Ash-grey earth, charcoal and soot, ember-orange light, weathered iron, bone-pale cloth; for the sea creatures, wet slate-blue shell, barnacles and a cold sea-green glow. Drifting cinders, volumetric haze, shallow depth of field, anamorphic lens, slow deliberate camera. Characters keep the exact design, silhouette and colors of their reference images. No subtitles, no captions, no on-screen text unless the shot asks for it.
narrator: deep, gravelly, weary male narrator, low and close to the microphone, one voice throughout. Speaks english.
---

# Horizon Zero: trailer

One 30-second Seedance clip. The seven shots below are beats inside it, separated by hard cuts. `generate.mjs` turns them into a single timecoded multi-shot prompt and makes one generation request; nothing is stitched afterwards.

`imageN` in the front matter names a folder under `assets/`. The generator sends that folder's `<name>.approved.png` as reference image N, so every shot calls it `@ImageN`. Each shot has a `duration` in seconds; the clip length is their sum. `voiceover` is optional and becomes a quoted narrator line at that timecode, which Seedance speaks when `generate_audio` is on. `style` and `narrator` apply to the whole clip.

The beats: the frontier burned, and three peoples came out of it. The dead got up as the Ashborn, the last grove walked out as the Rootborn, and the Deeplings crawled up from the drowned harbor. Two armies take their places on a grid, the fight plays out, and the title closes on one survivor of each people at the horizon.

## 1. The ash wakes

- duration: 4
- voiceover: When the frontier burned, the dead got up.

```prompt
Dusk over the smoking ruins of a frontier city. Collapsed iron towers, broken Art Nouveau arches, ash falling like snow. Slow push-in across a field of grey ash mounds. One mound cracks open with ember light and the Ashborn soldier from @Image1 claws its way up, soot and charred bone knitting together, its hollow eye sockets igniting ember-orange. Behind it, the lean Ashborn from @Image2 rises out of another mound in silhouette. Sound: low wind, crackling embers, a distant deep drum hit.
```

## 2. The grove walks

- duration: 4
- voiceover: The last grove pulled up its roots.

```prompt
A blackened forest under a red-grey sky, every tree burned to charcoal except one. Low-angle shot: the huge ancient tree creature from @Image8 tears its roots out of the scorched earth and takes one heavy step toward the camera, ember-orange light glowing in the hollow of its chest. At its feet the wiry creature of braided thorns from @Image6 unfurls, thorns bristling, eyes lighting up. Sound: wood groaning and splitting, a deep rumbling footfall, a rising string drone.
```

## 3. The tide turns

- duration: 4
- voiceover: And something crawled out of the black tide.

```prompt
A drowned harbor at night, sunken ship hulls and rusted chains rising out of ash-black water. The crab warrior from @Image11 drags itself onto a broken stone pier, its huge claw scraping the stones. Beside it the eel creature from @Image12 slides out of the water, fins flaring, and behind them the jellyfish shaman from @Image14 rises from the surface, its bell-shaped head and tendrils glowing cold sea-green, its diving-bell lantern swinging. Sound: waves slapping stone, dripping water, a low eerie choir note.
```

## 4. Take the field

- duration: 5
- voiceover: Pick a people. Pick your soldiers. Lock them in.

```prompt
High three-quarter view of a battlefield made of chunky square ash-stone tiles like @Image9, laid out as a grid, with a few broken rubble blocks like @Image10 scattered across it. The camera cranes down slowly. On the near two rows, tiles light up cold sea-green one by one and sea creatures like @Image11 and @Image13 step onto them and plant their feet. On the far two rows, tiles glow a sickly green-amber and the rose creature from @Image7 and thorn creatures like @Image6 take root on them. Both lines stand still, facing each other across the empty middle of the grid. Sound: heavy stone thuds as each unit lands, a ticking metallic rhythm building tension.
```

## 5. First blood

- duration: 4
- voiceover: No second chances. Fate rolls the dice.

```prompt
The armies collide on the tile grid. Fast tracking shot: the Ashborn skirmisher from @Image2 sprints across the tiles in a burst of embers and slashes at the crab warrior from @Image11, which snaps its huge claw shut on the blade. In the background the pufferfish creature from @Image13 hurls a spine that streaks overhead, and the Ashborn archer from @Image3 looses an arrow trailing fire in return. Sparks, shell fragments and ash fill the air. Quick but readable action, impactful hits. Sound: whoosh of the sprint, a hard crack of shell, arrow and spine hissing past, a percussive score kicking in.
```

## 6. Ember, thorn and tide

- duration: 4
- voiceover: Every order you gave plays out, exactly as you wrote it.

```prompt
Spell exchange on the tile grid. The rose creature from @Image7 whips its vine sling and a cluster of thorns knocks an Ashborn soldier back a full tile. The jellyfish shaman from @Image14 raises its tentacles and a cold green wave rolls across the tiles, shoving two enemies backward. The Ashborn warden from @Image5 raises its hands and a warm ember-gold glow washes over a wounded ally, cracks sealing shut. Slow-motion on each impact, then snapping back to speed. Sound: thorns whistling, a rushing wave, a warm chime for the heal, a deep bass pulse.
```

## 7. Horizon

- duration: 5
- voiceover: Three peoples. One horizon. Claim it.

```prompt
The battle is over. Slow pull-back and rise from the tile grid at golden ember dusk. Three survivors stand far apart among drifting cinders, silhouetted against a burning horizon: the Ashborn soldier from @Image1, the great tree creature from @Image8, and the glowing jellyfish shaman from @Image14. The camera keeps rising until the grid becomes small, then the frame darkens and the words "HORIZON ZERO" form out of glowing embers in the center of the screen in an elegant Art Nouveau serif typeface, perfectly spelled. Sound: the score swells to one final deep hit, then embers crackling into silence.
```
