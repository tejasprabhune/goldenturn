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

= What is debate?

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

Given this, the structure of debate revolves around two primary burdens:
+ the burden of proof (affirmative)
+ the burden of rejoinder (negative)

To show that the action in the resolution should be taken by its actor, the affirmative team
must _prove_ the resolution true. In the above example, if the affirmative
can prove that it is true that the US federal government should enact the act,
then we have determined that it is a desirable action (and so we should take it). This
is the affirmative's _burden of proof_.

Now, this burden of proof is not as simple as it seems. Let's take a step back and look
at what type of statements a person can make (since of course, the resolution is
an example of a statement someone makes).

#frame(showybox(
  title: "Stokes' theorem",
  frame: (
    border-color: blue,
    title-color: blue.lighten(30%),
    body-color: blue.lighten(95%),
    footer-color: blue.lighten(80%)
  ),
  footer: "Information extracted from a well-known public encyclopedia"
)[
  Let $Sigma$ be a smooth oriented surface in $RR^3$ with boundary $diff Sigma equiv Gamma$. If a vector field $bold(F)(x,y,z)=(F_x (x,y,z), F_y (x,y,z), F_z (x,y,z))$ is defined and has continuous first order partial derivatives in a region containing $Sigma$, then

  $ integral.double_Sigma (bold(nabla) times bold(F)) dot bold(Sigma) = integral.cont_(diff Sigma) bold(F) dot dif bold(Gamma) $
])
