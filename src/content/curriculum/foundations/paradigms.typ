#metadata((
  title: "Paradigms",
  section: "foundations",
  order: 3,
  prerequisites: (),
  related_articles: (),
  related_ks: (),
  related_recordings_tags: (),
  related_files: (),
  draft: true,
))<frontmatter>

#import "@preview/showybox:2.0.4": showybox
#import "../_setup.typ": frame

Worldviews of debate---how you should think about debate, the axes along which
you optimize, and the implications on your argument construction.

= a paradigm of debate

You may have heard of debate paradigms: the long (or short!) descriptions on #link("https://tabroom.com")[Tabroom]
of judge preferences and random thoughts. However, these are not restricted to judging only. Paradigms
are worldviews of debate---your understanding of how debate functions, what beliefs you enter the round with,
what arguments are "legitimate", the burdens of each side, and more. We've covered some part of this
in #link("burdens")[Burdens], but we will explore these ideas in earnest here. I will offer my own
opinionated analysis of how I believe debate ought to function, hopefully laying the groundwork
so that you will come to your own opinions over time.

= the judge and the ballot

The entirety of debate as an adversarial game revolves around the ballot. It is the most important
signal that dictates whether a given strategy is winning or losing. Notably, the ballot is submitted
by a _judge_, the character who listens, flows, and ultimately is the adjudicator of a given debate
round. There exists inherent variance in the judge, stemming from the many, diverse judges that
frequent the parliamentary debate circuits. Each can be viewed as a sort of _black box_---the only
real information we have about each judge is their ballot in various rounds. It's the only true,
grounded signal of what kinds of strategies and execution that a judge finds convincing or
unconvincing. Of course, we can employ certain heuristics (e.g. the judge's background, where they
come from, their written paradigm, etc.) to help us understand what might have led to a
certain round decision, but these again must center around the tangible ballots that the judge
has submitted.

This formulation of the ballot gives us a striking starting point for how to view debate---the
best debate strategy is one that will win most _on average_
(across all possible judges and resolutions that we may encounter). It is then intuitive
to start with looking at what an ideal judge entails with associated strategies, then modifying
our perspective by looking at an aggregate of current judges in the circuit with strategies
that then adapt to those judges.

= the ideal judge

We begin by considering what attributes we desire from an ideal judge. I use the word
"ideal" here to largely mean fair---both the affirmative and negative have an equal chance
to win the round under any given resolution.

Consider a judge with some amount of bias, let's say $b$ amount of bias (where bias refers to
a set of beliefs about the world that the judge considers true before the round begins).
Is this ever desirable? Intuively, no: any bias $b$ explicitly gives one side an advantage.
Taking the limit, one bias could be simply believing the resolution is true! This belief would
make it impossible for the negative to win. *A biased judge is undesirable.*

Consider a judge that does not use clash as the primary way to determine truth. For example,
assuming that whoever speaks first or last is automatically correct. Of course, such a judge
would only vote affirmative (since the affirmative speaks first and last in parli). However,
if instead _clash_ is used to determine the truth of any argument mentioned in the round,
fairness is reasonably maintained. For example, if an argument is made by the affirmative
and never responded to by the negative, we can be confident that this argument is "true"
so far (since the affirmative made a claim and offered a burden of proof that is uncontested).
The moment the negative responds to the affirmative in any way, we add a certain degree of
"doubt" onto the original affirmative claim. How much doubt? Unfortunately, this both
depends on the claims being made, and sometimes is difficult/impossible to know who is right
without introducing some prior "known" facts about the world.

#frame(showybox(
  title: "Exercise: Astro-Cheese",
  frame: (
    border-color: purple,
    title-color: purple.lighten(30%),
    body-color: purple.lighten(95%),
  )
)[

  Affirmative's claim: The moon is made from cheese.

])
