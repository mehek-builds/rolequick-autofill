# Graph Report - .  (2026-07-21)

## Corpus Check
- 88 files · ~122,678 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 473 nodes · 856 edges · 22 communities detected
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
Cohesion: 0.08
Nodes (37): candidateInputs(), classifyField(), clean(), controlIdentity(), dateSkipReason(), declaredLanguages(), desiredAnswer(), eeoAnswer() (+29 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (27): abandonTypedQuery(), closeOpenCombobox(), comboControl(), declaresPhoneAutocomplete(), documentSlotReason(), driveAsyncLocationCombobox(), fileInputLabelText(), fillField() (+19 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (19): createSession(), generateDraft(), generateResume(), getApplicationProfile(), getEvents(), getProductMeta(), getProfile(), putApplicationProfile() (+11 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (4): ap(), runFill(), ap(), run()

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (21): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), comboControlIn(), fillCombobox(), fillGreenhouseApplication(), fillResumeFile(), findPhoneCountryControl(), firstMatch() (+13 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (9): classifySubmissionOutcome(), pageShowsSubmissionConfirmation(), pageSubmissionFailureMessage(), resumeGenerationProgress(), resumeGenerationStatus(), cssEscape(), extractValidationErrors(), label() (+1 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (18): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), buttonOptionsIn(), checkRadio(), comboControlIn(), extractDescriptionHtmlFromSource(), fetchAshbyJdFromApi(), fetchAshbyJdFromPage() (+10 more)

### Community 8 - "Community 8"
Cohesion: 0.13
Nodes (14): gradeQuestion(), isFourPointScale(), ap(), at(), ukBand(), answerChoiceBlock(), blockAlreadyAnsweredForGrade(), comboControlIn() (+6 more)

### Community 9 - "Community 9"
Cohesion: 0.2
Nodes (19): collectCurrencies(), currencyPrefixAt(), dedupeRanges(), detectCurrency(), findStatedRanges(), groupDigits(), isProseSalary(), mapCurrencyToken() (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.14
Nodes (13): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), checkRadio(), comboControlIn(), fillCombobox(), fillLinkedInApplication(), fillResumeFile(), getModal() (+5 more)

### Community 11 - "Community 11"
Cohesion: 0.2
Nodes (16): answerChoiceBlock(), blockAlreadyAnsweredForGrade(), comboControlIn(), fillCombobox(), fillResumeFile(), fillWorkdayApplication(), findApplyManuallyButton(), hasAccountCreationMarkers() (+8 more)

### Community 12 - "Community 12"
Cohesion: 0.18
Nodes (11): collect(), escapeId(), handleInput(), isOurNode(), keyFor(), readControlValue(), readIdentity(), readQuestion() (+3 more)

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
Cohesion: 0.6
Nodes (3): isoOnlyPicker(), monthFirstPicker(), pickerThatAccepts()

### Community 17 - "Community 17"
Cohesion: 1.0
Nodes (0): 

### Community 18 - "Community 18"
Cohesion: 1.0
Nodes (0): 

### Community 19 - "Community 19"
Cohesion: 1.0
Nodes (0): 

### Community 20 - "Community 20"
Cohesion: 1.0
Nodes (0): 

### Community 21 - "Community 21"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Community 17`** (2 nodes): `storage.test.ts`, `lastError()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 18`** (2 nodes): `persistent-badge.ts`, `main()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (1 nodes): `tailwind.config.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 20`** (1 nodes): `postcss.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (1 nodes): `globals.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.11 - nodes in this community are weakly interconnected._
- **Should `Community 6` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._