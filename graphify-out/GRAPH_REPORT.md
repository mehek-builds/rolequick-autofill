# Graph Report - .  (2026-07-21)

## Corpus Check
- 86 files · ~121,033 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 464 nodes · 843 edges · 25 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `fillGenericApplication()` - 25 edges
2. `fillGreenhouseApplication()` - 13 edges
3. `request()` - 12 edges
4. `fillAshbyApplication()` - 11 edges
5. `resolveSalary()` - 10 edges
6. `fillLinkedInApplication()` - 9 edges
7. `languageAnswerPlan()` - 9 edges
8. `driveAsyncLocationCombobox()` - 9 edges
9. `findStatedRanges()` - 8 edges
10. `waitForStableDom()` - 8 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (5): normalizeContact(), statusFromTier(), handleUrlChange(), parseJobUrl(), slugToName()

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (37): candidateInputs(), classifyField(), clean(), controlIdentity(), dateSkipReason(), declaredLanguages(), desiredAnswer(), eeoAnswer() (+29 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (27): abandonTypedQuery(), closeOpenCombobox(), comboControl(), declaresPhoneAutocomplete(), documentSlotReason(), driveAsyncLocationCombobox(), fileInputLabelText(), fillField() (+19 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (4): cssEscape(), extractValidationErrors(), label(), nearestFieldEntryLabel()

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (20): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), buttonOptionsIn(), checkRadio(), comboControlIn(), ap(), runFill(), extractDescriptionHtmlFromSource() (+12 more)

### Community 5 - "Community 5"
Cohesion: 0.15
Nodes (17): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), comboControlIn(), fillCombobox(), fillGreenhouseApplication(), fillResumeFile(), findPhoneCountryControl(), firstMatch() (+9 more)

### Community 6 - "Community 6"
Cohesion: 0.2
Nodes (19): collectCurrencies(), currencyPrefixAt(), dedupeRanges(), detectCurrency(), findStatedRanges(), groupDigits(), isProseSalary(), mapCurrencyToken() (+11 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (9): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), comboControlIn(), fillCombobox(), fillLeverApplication(), fillResumeFile(), isNeverFillField(), labelTextFor() (+1 more)

### Community 8 - "Community 8"
Cohesion: 0.13
Nodes (6): fetchAshbyPostingCompensation(), generateResumeAndProfile(), harvestFields(), resolveAndDraft(), sleep(), timeoutFetch()

### Community 9 - "Community 9"
Cohesion: 0.2
Nodes (16): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), comboControlIn(), fillCombobox(), fillResumeFile(), fillWorkdayApplication(), findApplyManuallyButton(), hasAccountCreationMarkers() (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.19
Nodes (13): createSession(), generateDraft(), generateResume(), getApplicationProfile(), getEvents(), getProductMeta(), getProfile(), putApplicationProfile() (+5 more)

### Community 11 - "Community 11"
Cohesion: 0.18
Nodes (11): collect(), escapeId(), handleInput(), isOurNode(), keyFor(), readControlValue(), readIdentity(), readQuestion() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.25
Nodes (13): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), checkRadio(), comboControlIn(), fillCombobox(), fillLinkedInApplication(), fillResumeFile(), getModal() (+5 more)

### Community 13 - "Community 13"
Cohesion: 0.24
Nodes (10): chromeStorageGetCompat(), chromeStorageRemove(), chromeStorageSet(), clearAll(), clearToken(), getProfile(), getToken(), setAutoSubmitEnabled() (+2 more)

### Community 14 - "Community 14"
Cohesion: 0.31
Nodes (9): baseForm(), baseFormFields(), classicItiPhone(), coreFields(), geminiField(), markReactManaged(), requiredInput(), textInput() (+1 more)

### Community 15 - "Community 15"
Cohesion: 0.23
Nodes (10): dateOrderCandidates(), detectDateOrder(), formatDate(), isDateControl(), isRealDate(), pad(), parseStoredDate(), input() (+2 more)

### Community 16 - "Community 16"
Cohesion: 0.31
Nodes (5): gradeQuestion(), isFourPointScale(), ap(), at(), ukBand()

### Community 17 - "Community 17"
Cohesion: 0.53
Nodes (4): coreFields(), markReactManaged(), textInput(), wrapper()

### Community 18 - "Community 18"
Cohesion: 0.4
Nodes (2): ap(), run()

### Community 19 - "Community 19"
Cohesion: 0.6
Nodes (3): isoOnlyPicker(), monthFirstPicker(), pickerThatAccepts()

### Community 20 - "Community 20"
Cohesion: 1.0
Nodes (0): 

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (0): 

### Community 22 - "Community 22"
Cohesion: 1.0
Nodes (0): 

### Community 23 - "Community 23"
Cohesion: 1.0
Nodes (0): 

### Community 24 - "Community 24"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Community 20`** (2 nodes): `storage.test.ts`, `lastError()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (2 nodes): `persistent-badge.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 22`** (1 nodes): `tailwind.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 23`** (1 nodes): `postcss.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 24`** (1 nodes): `globals.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Community 7` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._
- **Should `Community 8` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._