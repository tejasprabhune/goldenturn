#metadata((
  title: "Burdens",
  section: "foundations",
  order: 2,
  prerequisites: (),
  related_articles: (),
  related_ks: (),
  related_recordings_tags: (),
  related_files: (),
  draft: false,
))<frontmatter>

#import "@preview/showybox:2.0.4": showybox
#import "../_setup.typ": frame

A brief introduction to the structure of debate and burdens.

= what is debate?

Debate is an adversarial game playing by two teams---the affirmative and negative---surrounding
what is known as a `resolution`:

```
The United States federal government should enact the Lower Drug Cost Now Act of 2019.
```

Why is it structured this way? Among a number of interpretations, debate can be seen
as a tool for *decision-making under conditions of scarcity*. An action is proposed
for an agent to take, and we as debaters must be adversaries to determine whether
this action should be taken. This interpretation comes from "parliamentary"
or "policy" debate---mimicking our governmental debates over potential action.

#frame(
  figure(
    image("../../../../public/res_action_actor.svg", width: 40%),
    caption: "an agent figuring out what action to take"
  )
)

Given this, the structure of debate revolves around two primary burdens:
+ *the burden of proof* (affirmative)
+ *the burden of rejoinder* (negative)

= the burden of proof

To show that the action in the resolution should be taken by its actor, the affirmative team
must _prove_ the resolution true. In the above example, if the affirmative
can prove that it is true that the US federal government should enact the act,
then we have determined that it is a desirable action (and so we should take it). This
is the affirmative's _burden of proof_.

Now, this burden of proof is not as simple as it seems. Let's take a step back and look
at what type of statements a person can make (since of course, the resolution is
an example of a statement someone makes).

*Positive/descriptive statements* are objective and factual. They answer
questions like what _is_, _was_, or _will be_. For example, "the sky
is blue" or "the US currently spends over a billion dollars in the military."
In contrast, *normative/prescriptive statements* are subjective and value-based. They
answer questions like what _should_ or _ought to_ be. For example, "the US should
decrease its military spending".

In parliamentary debate, you usually
debate resolutions that are normative statements. For example, policy-style 
resolutions like the example about the Lower Drug Cost Now Act
are _normative_ statements. Other resolutions, like "Public protests are effective",
may seem like positive statements, but "effective" is subjective and depends on
what success or value might look like to someone.

#frame(showybox(
  title: "Hume's Guillotine (is-ought problem)",
  frame: (
    border-color: blue,
    title-color: blue.lighten(30%),
    body-color: blue.lighten(95%),
  )
)[
  From Scottish philosopher David Hume in 1739 (not a quote):

  ```
  It is impossible to logically derive a moral rule (what ought to be) from a purely factual observation (what is)
  ```

  In other words, we cannot use positive statements alone to prove
  normative statements. For example, we can't jump from "we don't have
  energy" (positive) to "the US should invest in the energy grid"
  (normative) without assuming some underlying _value_ saying
  "we need a lot of energy".

  The next logical conclusion of this is that all normative statements
  must be justified by other normative statements. But this logic
  would become circular unless there was at least one _self-evident_
  or _axiomatic_ value or normative statement that we believe is true.
  Thus, the truth of a resolution will rely on debaters holding such a 
  value implicitly or explicitly (we will come back to this).
])

Now, the affirmative must answer the question: "how can we prove
the truth of the resolution?" (to satisfy their burden of proof). The
choice of underlying value (or _framework_) dictates the answer
to this question. For example, if the affirmative choose a form
of consequentialism (a framework that determines the desirability
of an action from the desirability of its consequences), they must
posit a set of consequences that will occur as a result of
resolution and explain why those consequences are "good".
So depending on the framework the affirmative chooses or assumes,
the method of proving the resolution true changes.

A natural follow-up question is: aren't there _so_ many ways that
the resolution's action could take place? It seems difficult for
the affirmative to have to prove that _every_ version of the
resolution is desirable to prove its truth. But the affirmative
doesn't need to defend all of them. If the affirmative chooses
a mechanism or some way that the resolution could be implemented
(called the *plan*) and proves that this advocacy
are net beneficial, they've shown that an instance of the resolution
should be done, and thus the resolution is true.

This burden of the affirmative confirms what we originally
started out with: a *role of the ballot* (ROB). You'll hear
this term thrown around a lot in technical rounds, but in the
large majority of policy rounds, the role of the ballot
is to *truth-test the resolution*. Truth-testing is an important
term that will come up again in the future---it simply refers to
the process of determining the truth (or at least how true)
a statement is.

#frame(showybox(
  title: "Exercise: Truth-Testing in Debate",
  frame: (
    border-color: purple,
    title-color: purple.lighten(30%),
    body-color: purple.lighten(95%),
  )
)[
  In debate, we're extremely restricted since all
  we can do is give our speeches (and maybe engage
  in cross-examination of the other team). We absolutely cannot
  run scientific experiments or bring physical tools into
  rounds. Given these difficult constraints, how can we
  fully determine the *truth* of a statement (i.e. truth-test)?
  An interesting follow-up: what is unique about debate
  that allows us to truth-test statements in a way that no
  other source of education can (e.g. reading a book)?

  _Answer:_ Clash! What is clash? It's the process of
  directly responding to arguments with new arguments, turns,
  and disagreeing evidence. It turns out that clash is the 
  only way (to my knowledge) of determining truth in a debate
  round. See the section on the *Judge* where we explore this
  more.
])

*tl;dr*: the affirmative's burden is to prove the resolution
true. An underlying value is assumed (or debated), and the
affirmative commonly chooses a specific implementation of the
resolution to defend.

= the burden of rejoinder

The next natural question is: what does the negative do? If
the ROB is to truth-test the resolution, it seems as though
the negative burden should be to prove the falsity of the
resolution.

Now, if the negative had to do this in a vacuum, this can be
exceedingly difficult! There seem to a multitude of ways to
implement the action of a resolution---e.g.:

```
The United States federal government should increase its investment in energy.
```

Energy! What kind of energy? By how much should investment be?
Does the negative have to negate every possible form of investment
in order to prove the resolution false? This interpretation effectively
forces the negative to prove true the statement:

```
There are no instances where the United States federal government should increase its investment in energy.
```

which is similar to the Black Swan problem. We can't determine whether a statement
like `All swans are white` is true without checking the color of all swans, and if we
aren't exhaustive, we cannot conclude truth with certainty. Any counterexample to such
a totalizing statement will prove it false.

Fortunately, the negative does not have this burden. The original burden of proof of the
resolution means "one who asserts/affirms must prove"---and if
this proof is insufficient or shown to be false, then we _presume_ that the resolution
is false.

#frame(showybox(
  title: "Presumption",
  frame: (
    border-color: blue,
    title-color: blue.lighten(30%),
    body-color: blue.lighten(95%),
  )
)[
  From Merriam-Webster, to presume is:
  1. to undertake without leave or clear justification
  2. to expect or assume especially with confidence
  3. to suppose to be true without proof

  Additionally, "presume" is _different_ from "assume" since
  presumption typically includes informed guessing from
  past experience or evidence.

  In debate, the resolution typically advocates for a departure
  from the status quo, and the affirmative demonstrates or proves that
  this departure is good. Why? Any governmental action requires energy
  and external costs that must be justified by net benefits (or whatever
  value you prefer) over the current state of affairs.

  #frame(
    figure(
      image("../../../../public/res_instances.svg", width: 80%),
      caption: "how various instances of the resolution depart from the status quo"
    )
  )

  Imagine the above figure: there are a multitude of possible implementations
  of the resolutional action that the affirmative (as an agent, usually governmental)
  can choose from. Everyone (the affirmative, negative, judge, etc.) all start at
  ground zero---the status quo. This is the current state of affairs, and future state
  of affairs if we imagine that the resolutional action is not implemented. We
  _presume_ that absent any justifications for resolutional action, we should stay
  at business-is-usual and maintain the status quo.

  You might hear "presumption flips neg" or "vote negative on presumption". Both of these
  phrases simply mean that for some $x$ reason, the affirmative has not sufficiently 
  justified why the plan is not better than the status quo, and so the judge should vote negative.
])

Every round starts with the affirmative speech---a plan is introduced and justified as a course
of action that departs from the status quo. At this point, there is no reason to believe that
the affirmative claims aren't true. However, the moment the negative _responds to_ or _rejoins_
the affirmative, the affirmative case's truth value comes into question. This is the negative's
*burden of rejoinder*: the negative must disprove or negate the affirmative to win the round.
It's important to remember that since the affirmative has chosen an _instance_ of the resolution
to defend, the negative doesn't have to negate the _entire_ resolution, but rather negate
the specific instance of the resolution that the affirmative chooses.

*tl;dr*:
1. The negative must negate the affirmative to satisfy their burden of rejoinder.
2. With this burden, the negative proves that the affirmative plan is not preferable to
  (or worse than) the status quo.
3. If the negative does so, the judge "presumes" (or votes negative on presumption),
  which indicates that the benefits of the affirmative plan have not been sufficiently
  justified over the cons, costs, and resources, and thus the current state of affairs is preferred.
