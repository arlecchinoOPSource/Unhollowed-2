# Beta usability testing protocol

Protocol for U2-P6-12. **No usability sessions have been run.** This document prepares them. The results section is empty on purpose and must only be filled from real sessions. Do not copy, invent, or paraphrase tester feedback that was not observed.

## Goals

Find where people who have never seen the app get stuck, before public distribution. Measure whether they can finish ordinary work, how long a first project and first document take, where they hesitate, how they recover from mistakes, and what formatting gets in their way.

## Who to recruit

Five to eight people who have never used Unhollowed or any Arlecchino app and do not know how it was built. Aim for at least one of each:

| Audience                          | Why                                                      |
| --------------------------------- | -------------------------------------------------------- |
| University student                | Notes, deadlines, a habit, a paper in a word processor   |
| Office worker                     | Tasks, meetings, documents shared as Word files          |
| Independent creative professional | Several projects, client documents, a flexible schedule  |
| Existing Notion or Obsidian user  | Expectations about links, folders, and a knowledge graph |

Record only the audience group and platform for each participant (for example "P3, student, macOS"). Do not record names, email addresses, employers, or faces.

## Consent and privacy (read aloud before each session)

1. The test is of the app, not of you. You can stop at any time without giving a reason.
2. You will use a prepared test workspace with made-up data. Do not enter any real personal information.
3. We take written notes. If the screen or audio is recorded, it is stored only on the facilitator's machine, never uploaded, and deleted within 30 days. Recording is optional and you can decline it.
4. Notes are anonymous (P1, P2, ...). Quotes in reports will not identify you.
5. You will not be paid by, or obligated to, the project unless it was agreed in advance. (Record any agreed compensation outside this repository.)

Record only that consent was given, with the date, outside the repository.

## Setup

- A clean install of the beta build on a fresh user account or machine, with the app data folder empty (see [Backup](BACKUP.md) for its location). Never use anyone's everyday workspace.
- Record the app version, commit, operating system, and screen size.
- Optional starter data: one example project so the first-run state is not lost, but run Task 1 on an empty workspace first.
- The facilitator sits beside the participant, says nothing about how to do a task, and answers questions with "What would you try?" until the participant gives up or asks to move on. Time-box each task to 10 minutes.

## Tasks (outcomes, not instructions)

Give each task as a sentence. Do not name buttons or screens.

| #   | Task given to the participant                                                                                                                                            | What it shows                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 1   | "You are starting a new project, a group presentation due in two weeks. Set it up so you can track what you need to do."                                                 | First project, first-run orientation |
| 2   | "Add the four things you need to do. Make one of them urgent and give another a due date."                                                                               | Issues, priority, dates              |
| 3   | "Write a one-page outline for the presentation with a title, two headings, a short list, and one important word in bold. Keep it with the project."                      | First document, formatting, linking  |
| 4   | "Block out two hours on Thursday afternoon to work on it, and make a weekly meeting every Monday at 10."                                                                 | Calendar, recurring event            |
| 5   | "You want to drink more water. Set up something to track that and mark that you did it today and yesterday."                                                             | Habits, past days                    |
| 6   | "Note how your day feels today."                                                                                                                                         | Mood check-in                        |
| 7   | "You finished one of the tasks. Show that it's done and find out how much of the project is complete."                                                                   | Completion, dashboard                |
| 8   | "Make a Word file of your outline to send to a teammate."                                                                                                                | Export                               |
| 9   | "Oops: you deleted the wrong thing (or typed over your outline). Get it back." (Facilitator names one real recoverable mistake they made, or have them delete an issue.) | Error recovery                       |
| 10  | Notion or Obsidian users only: "Link your outline to another note and see how they connect."                                                                             | Document links, graph                |
| 11  | "Close the app completely and open it again. Is everything where you left it?"                                                                                           | Trust in persistence                 |

## What to record per task

| Field                 | Definition                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome               | **Completed** without help; **completed with a hint** (note the hint); **failed or abandoned**                                                       |
| Time on task          | Seconds from the end of the prompt to the participant saying they are done. Tasks 1 and 3 give "time to first project" and "time to first document". |
| Navigation confusion  | Count of times the participant went to a screen that did not hold what they wanted, or said "where is..."                                            |
| Formatting difficulty | Count of times they could not apply, find, or undo a text or layout change (Task 3 and 8)                                                            |
| Error recovery        | Whether they noticed the mistake, how they fixed it, and whether they trusted the result                                                             |
| Quote                 | One short verbatim phrase, if useful (anonymous)                                                                                                     |
| Severity              | 0 none, 1 cosmetic, 2 slowed them, 3 blocked them, 4 lost or risked their data                                                                       |

After the tasks ask: "What was the most confusing moment?", "What would you tell a friend this app is for?", and "What did you expect to find that wasn't there?"

## Success criteria

The beta passes this gate when, across all participants, and with no session discarded:

- At least 80% of Tasks 1 to 3, 7, and 11 are completed without help (a hint counts as not completed).
- The median time to a first project is under 3 minutes and to a first formatted document under 8 minutes (starting values to review once real data exists).
- No severity 4 issue (data loss or risk) is observed. A severity 3 issue is fixed or recorded as an owner-approved deferral in the release notes.
- Every severity 2 or higher observation is turned into a GitHub issue.

## Turning observations into issues

For each observation of severity 2 or higher, open a bug or feature issue with:

- The task and participant label (P4), the version, and the platform.
- Numbered reproduction steps using sample data, the expected outcome, and what happened.
- The severity, a short anonymous quote if useful, and how many participants hit it ("3 of 6").
- No names, personal data, or screen recordings. Use the existing bug template and add the label `source:usability`.

Link each issue from the results table below.

## Session log template

Copy this block for each participant and keep the filled-in copies outside the repository until anonymized.

```
Participant: P_  Audience: _  Platform: _  App version/commit: _  Date: _
Consent given: yes/no  Recording: yes/no
Task | Outcome | Seconds | Confusion | Formatting | Recovery | Severity | Notes
1    |         |         |           |            |          |          |
... (one row per task)
Debrief answers:
```

## Results

| Item                                 | Value        |
| ------------------------------------ | ------------ |
| Sessions run                         | 0            |
| Participants by audience             | none         |
| Platforms                            | none         |
| Completion rate, Tasks 1 to 3, 7, 11 | not measured |
| Median time to first project         | not measured |
| Median time to first document        | not measured |
| Issues opened from sessions          | none         |

## Status

Protocol ready. The sessions need real people and a packaged build, which an automated change cannot supply. The acceptance criteria for this gate remain open until a maintainer runs them and fills in the results above, or records an owner decision to defer them.
