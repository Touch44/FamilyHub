/**
 * FamilyHub v2.0 — core/graph-engine.js
 * Entity type registry and graph query layer
 * Blueprint §2.5 (entity type configs), §10.2 (public API)
 *
 * Public API (all named exports):
 *   initGraphEngine,
 *   getEntityTypeConfig, getAllEntityTypes,
 *   saveEntityType, archiveEntityType,
 *   getBacklinks, getNeighbors,
 *   getRelationLabel, convertEntity
 */

import { getSetting, setSetting, getEdgesFrom, getEdgesTo,
         getEntity, saveEntity, initDB } from './db.js';
import { emit, EVENTS } from './events.js';

// ── Settings key ─────────────────────────────────────────── //

const SETTINGS_KEY = 'entityTypes';

// ── notionPropType constants ──────────────────────────────── //
// Each field maps to one Notion property type for sync.
// Kept as a frozen enum so all configs below reference the same strings.

/** @readonly */
const N = Object.freeze({
  TITLE:    'title',
  RICH:     'rich_text',
  SELECT:   'select',
  MSELECT:  'multi_select',
  DATE:     'date',
  DATETIME: 'date',        // Notion uses same type; FH stores as ISO with time
  NUMBER:   'number',
  CHECKBOX: 'checkbox',
  URL:      'url',
  EMAIL:    'email',
  PHONE:    'phone_number',
  RELATION: 'relation',
  FORMULA:  'formula',
  FILES:    'files',
});

// ── Field type helpers ────────────────────────────────────── //

/** @typedef {'title'|'text'|'richtext'|'select'|'multiselect'|'date'|'datetime'|'number'|'checkbox'|'url'|'email'|'phone'|'relation'|'tags'|'files'} FieldType */

/**
 * Build a field descriptor.
 * @param {string}     key
 * @param {FieldType}  type
 * @param {object}     [opts]
 * @returns {object}
 */
function field(key, type, opts = {}) {
  // Derive the Notion property type automatically based on field type
  const notionMap = {
    title:       N.TITLE,
    text:        N.RICH,
    richtext:    N.RICH,
    select:      N.SELECT,
    multiselect: N.MSELECT,
    tags:        N.MSELECT,
    date:        N.DATE,
    datetime:    N.DATETIME,
    number:      N.NUMBER,
    checkbox:    N.CHECKBOX,
    url:         N.URL,
    email:       N.EMAIL,
    phone:       N.PHONE,
    relation:    N.RELATION,
    files:       N.FILES,
  };

  return {
    key,
    type,
    label:         opts.label    ?? _toLabel(key),
    isTitle:       opts.isTitle  ?? (type === 'title'),
    required:      opts.required ?? (type === 'title'),
    options:       opts.options  ?? null,   // for select / multiselect
    relatesTo:     opts.relatesTo ?? null,  // for relation fields
    notionPropType: notionMap[type] ?? N.RICH,
    ...opts,
  };
}

/** Convert camelCase key to Title Case label */
function _toLabel(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();
}

// ── Colour palette shared by several types ────────────────── //

const PERSON_COLORS = ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink'];
const TAG_COLORS    = ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink', 'Gray'];

// ── Built-in entity type configs (Blueprint §2.5) ─────────── //

/**
 * @typedef {object} EntityTypeConfig
 * @property {string}   key
 * @property {string}   label
 * @property {string}   labelPlural
 * @property {string}   icon
 * @property {string}   color          - CSS hex or var token
 * @property {object[]} fields
 * @property {string}   defaultSort    - field key, optionally prefixed '-' for desc
 * @property {string[]} actions
 * @property {boolean}  isBuiltIn
 * @property {boolean}  graphVisible
 * @property {string[]} views
 * @property {boolean}  [archived]
 */

/** @type {EntityTypeConfig[]} */
const BUILT_IN_ENTITY_TYPES = [

  // ── 1. task ─────────────────────────────────────────────── //
  {
    key:         'task',
    label:       'Task',
    labelPlural: 'Tasks',
    icon:        '✅',
    color:       '#4f8ef7',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort: '-createdAt',
    views:       ['kanban', 'list', 'calendar'],
    actions:     ['create', 'edit', 'delete', 'duplicate', 'convert', 'relate'],
    fields: [
      field('title',      'title',    { isTitle: true, label: 'Title' }),
      field('status',     'select',   { label: 'Status',   options: ['Inbox', 'In Progress', 'Review', 'Done'] }),
      field('priority',   'select',   { label: 'Priority', options: ['Low', 'Medium', 'High', 'Critical'] }),
      field('dueDate',    'date',     { label: 'Due Date' }),
      field('dueTime',    'time',     { label: 'Due Time', placeholder: '06:00', helpText: 'Time of day (defaults to 6:00 AM if not set)' }),
      field('assignedTo', 'relation', { label: 'Assigned To', relatesTo: 'person' }),
      field('project',    'relation', { label: 'Project',     relatesTo: 'project' }),
      field('tags',       'tags',     { label: 'Tags' }),
      field('details',    'richtext', { label: 'Details', isTitle: false }),
      field('blockedBy',  'relation', { label: 'Blocked By', relatesTo: 'task' }),
      field('effort',     'select',   { label: 'Effort', options: ['XS', 'S', 'M', 'L', 'XL'] }),
    ],
  },

  // ── 2. person ───────────────────────────────────────────── //
  {
    key:         'person',
    label:       'Person',
    labelPlural: 'People',
    icon:        '👤',
    color:       '#f7974f',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'name',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'convert', 'relate'],
    fields: [
      field('name',     'title',    { isTitle: true, label: 'Name' }),
      field('role',     'select',   { label: 'Role', options: ['Parent', 'Child', 'Guardian', 'Guest'] }),
      field('birthday', 'date',     { label: 'Birthday' }),
      field('email',    'email',    { label: 'Email' }),
      field('phone',    'phone',    { label: 'Phone' }),
      field('notes',    'richtext', { label: 'Notes', isTitle: false }),
      field('color',    'select',   { label: 'Color', options: PERSON_COLORS }),
    ],
  },

  // ── 3. event ────────────────────────────────────────────── //
  {
    key:         'event',
    label:       'Event',
    labelPlural: 'Events',
    icon:        '📅',
    color:       '#a855f7',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'date',
    views:        ['calendar', 'list'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('date',     'datetime', { label: 'Start', required: true }),
      field('endDate',  'datetime', { label: 'End' }),
      field('location', 'text',     { label: 'Location' }),
      field('type',     'select',   { label: 'Type', options: ['Family', 'School', 'Work', 'Medical', 'Social', 'Holiday'] }),
      field('notes',    'richtext', { label: 'Notes', isTitle: false }),
      field('members',  'relation', { label: 'Members', relatesTo: 'person' }),
    ],
  },

  // ── 4. note ─────────────────────────────────────────────── //
  {
    key:         'note',
    label:       'Note',
    labelPlural: 'Notes',
    icon:        '📝',
    color:       '#fbbf24',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  '-updatedAt',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'convert', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('body',     'richtext', { label: 'Body', isTitle: false }),
      field('category', 'select',   { label: 'Category', options: ['Inbox', 'Daily', 'Project'] }),
      field('tags',     'tags',     { label: 'Tags' }),
    ],
  },

  // ── 5. project ──────────────────────────────────────────── //
  {
    key:         'project',
    label:       'Project',
    labelPlural: 'Projects',
    icon:        '📁',
    color:       '#10b981',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'name',
    views:        ['list', 'kanban', 'grid'],
    actions:      ['create', 'edit', 'delete', 'archive', 'convert', 'relate'],
    fields: [
      field('name',     'title',    { isTitle: true, label: 'Name' }),
      field('status',   'select',   { label: 'Status', options: ['Active', 'On Hold', 'Complete', 'Archived'] }),
      field('goal',     'text',     { label: 'Goal' }),
      field('deadline', 'date',     { label: 'Deadline' }),
      field('members',  'relation', { label: 'Members', relatesTo: 'person' }),
      field('notes',    'richtext', { label: 'Notes', isTitle: false }),
    ],
  },

  // ── 6. document ─────────────────────────────────────────── //
  {
    key:         'document',
    label:       'Document',
    labelPlural: 'Documents',
    icon:        '📄',
    color:       '#ef4444',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'expiryDate',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'relate'],
    fields: [
      field('name',       'title',    { isTitle: true, label: 'Name' }),
      field('type',       'select',   { label: 'Type', options: ['Passport', 'License', 'Insurance', 'Medical', 'School', 'Other'] }),
      field('issueDate',  'date',     { label: 'Issue Date' }),
      field('expiryDate', 'date',     { label: 'Expiry Date' }),
      field('person',     'relation', { label: 'Person', relatesTo: 'person' }),
      field('fileUrl',    'url',      { label: 'File URL' }),
      field('notes',      'text',     { label: 'Notes', isTitle: false }),
    ],
  },

  // ── 7. tag ──────────────────────────────────────────────── //
  {
    key:         'tag',
    label:       'Tag',
    labelPlural: 'Tags',
    icon:        '🏷️',
    color:       '#6b7280',
    isBuiltIn:   true,
    graphVisible: false,
    defaultSort:  'name',
    views:        ['list'],
    actions:      ['create', 'edit', 'delete'],
    fields: [
      field('name',  'title',  { isTitle: true, label: 'Name' }),
      field('color', 'select', { label: 'Color', options: TAG_COLORS }),
    ],
  },

  // ── 8. budgetEntry ──────────────────────────────────────── //
  {
    key:         'budgetEntry',
    label:       'Budget Entry',
    labelPlural: 'Budget Entries',
    icon:        '💰',
    color:       '#059669',
    isBuiltIn:   true,
    graphVisible: false,
    defaultSort:  '-date',
    views:        ['list', 'table'],
    actions:      ['create', 'edit', 'delete', 'duplicate'],
    fields: [
      field('description', 'title',    { isTitle: true, label: 'Description' }),
      field('type',        'select',   { label: 'Type',     options: ['Income', 'Expense'] }),
      field('amount',      'number',   { label: 'Amount' }),
      field('category',    'select',   { label: 'Category', options: [
        'Food', 'Transport', 'Housing', 'Healthcare', 'Education',
        'Entertainment', 'Clothing', 'Utilities', 'Savings', 'Other',
      ]}),
      field('date',        'date',     { label: 'Date' }),
      field('person',      'relation', { label: 'Person',  relatesTo: 'person' }),
      field('project',     'relation', { label: 'Project', relatesTo: 'project' }),
    ],
  },

  // ── 9. recipe ───────────────────────────────────────────── //
  {
    key:         'recipe',
    label:       'Recipe',
    labelPlural: 'Recipes',
    icon:        '🍽️',
    color:       '#f97316',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'title',
    views:        ['grid', 'list'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',       'title',    { isTitle: true, label: 'Title' }),
      field('cuisine',     'select',   { label: 'Cuisine', options: [
        'Italian', 'Mexican', 'Chinese', 'Japanese', 'Indian',
        'French', 'American', 'Mediterranean', 'Thai', 'Other',
      ]}),
      field('prepTime',    'number',   { label: 'Prep Time (min)' }),
      field('cookTime',    'number',   { label: 'Cook Time (min)' }),
      field('servings',    'number',   { label: 'Servings' }),
      field('ingredients', 'richtext', { label: 'Ingredients', isTitle: false }),
      field('steps',       'richtext', { label: 'Steps',       isTitle: false }),
      field('photoUrl',    'url',      { label: 'Photo URL' }),
      field('tags',        'tags',     { label: 'Tags' }),
    ],
  },

  // ── 10. contact ─────────────────────────────────────────── //
  {
    key:         'contact',
    label:       'Contact',
    labelPlural: 'Contacts',
    icon:        '📇',
    color:       '#0ea5e9',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'name',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'relate'],
    fields: [
      field('name',         'title',    { isTitle: true, label: 'Name' }),
      field('relationship', 'text',     { label: 'Relationship' }),
      field('phone',        'phone',    { label: 'Phone' }),
      field('email',        'email',    { label: 'Email' }),
      field('notes',        'richtext', { label: 'Notes', isTitle: false }),
    ],
  },

  // ── 11. dateEntity ──────────────────────────────────────── //
  {
    key:         'dateEntity',
    label:       'Date',
    labelPlural: 'Dates',
    icon:        '🗓️',
    color:       '#ec4899',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'date',
    views:        ['calendar', 'list'],
    actions:      ['create', 'edit', 'delete', 'relate'],
    fields: [
      field('label',  'title',    { isTitle: true, label: 'Label' }),
      field('date',   'date',     { label: 'Date', required: true }),
      field('type',   'select',   { label: 'Type', options: ['Birthday', 'Anniversary', 'Holiday', 'Milestone'] }),
      field('person', 'relation', { label: 'Person', relatesTo: 'person' }),
    ],
  },

  // ── 12. idea ────────────────────────────────────────────── //
  {
    key:         'idea',
    label:       'Idea',
    labelPlural: 'Ideas',
    icon:        '💡',
    color:       '#facc15',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  '-createdAt',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'convert', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('body',     'richtext', { label: 'Body',   isTitle: false }),
      field('status',   'select',   { label: 'Status', options: ['Raw', 'Developing', 'Shelved', 'Done'] }),
      field('tags',     'tags',     { label: 'Tags' }),
      field('project',  'relation', { label: 'Project', relatesTo: 'project' }),
    ],
  },

  // ── 13. research ────────────────────────────────────────── //
  {
    key:         'research',
    label:       'Research',
    labelPlural: 'Research Items',
    icon:        '🔬',
    color:       '#8b5cf6',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  '-updatedAt',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'convert', 'relate'],
    fields: [
      field('title',   'title',    { isTitle: true, label: 'Title' }),
      field('summary', 'richtext', { label: 'Summary', isTitle: false }),
      field('source',  'url',      { label: 'Source URL' }),
      field('status',  'select',   { label: 'Status', options: ['Unread', 'Reading', 'Done', 'Archived'] }),
      field('topic',   'text',     { label: 'Topic' }),
      field('tags',    'tags',     { label: 'Tags' }),
    ],
  },

  // ── 14. book ────────────────────────────────────────────── //
  {
    key:         'book',
    label:       'Book',
    labelPlural: 'Books',
    icon:        '📚',
    color:       '#a16207',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'title',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('author',   'text',     { label: 'Author' }),
      field('status',   'select',   { label: 'Status', options: ['Want to Read', 'Reading', 'Done', 'Abandoned'] }),
      field('rating',   'select',   { label: 'Rating', options: ['1', '2', '3', '4', '5'] }),
      field('genre',    'select',   { label: 'Genre',  options: ['Fiction', 'Non-Fiction', 'Biography', 'Science', 'History', 'Self-Help', 'Other'] }),
      field('notes',    'richtext', { label: 'Notes',  isTitle: false }),
      field('tags',     'tags',     { label: 'Tags' }),
    ],
  },

  // ── 15. trip ────────────────────────────────────────────── //
  {
    key:         'trip',
    label:       'Trip',
    labelPlural: 'Trips',
    icon:        '✈️',
    color:       '#0891b2',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'startDate',
    views:        ['list', 'calendar', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',       'title',    { isTitle: true, label: 'Title' }),
      field('destination', 'text',     { label: 'Destination' }),
      field('startDate',   'date',     { label: 'Start Date' }),
      field('endDate',     'date',     { label: 'End Date' }),
      field('status',      'select',   { label: 'Status', options: ['Planning', 'Booked', 'In Progress', 'Done'] }),
      field('members',     'relation', { label: 'Travellers', relatesTo: 'person' }),
      field('notes',       'richtext', { label: 'Notes',      isTitle: false }),
      field('tags',        'tags',     { label: 'Tags' }),
    ],
  },

  // ── 16. place ───────────────────────────────────────────── //
  {
    key:         'place',
    label:       'Place',
    labelPlural: 'Places',
    icon:        '📍',
    color:       '#16a34a',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'name',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'relate'],
    fields: [
      field('name',     'title',  { isTitle: true, label: 'Name' }),
      field('address',  'text',   { label: 'Address' }),
      field('type',     'select', { label: 'Type', options: ['Home', 'School', 'Work', 'Restaurant', 'Park', 'Medical', 'Other'] }),
      field('mapUrl',   'url',    { label: 'Map Link' }),
      field('notes',    'richtext', { label: 'Notes', isTitle: false }),
      field('tags',     'tags',   { label: 'Tags' }),
    ],
  },

  // ── 17. weblink ─────────────────────────────────────────── //
  {
    key:         'weblink',
    label:       'Web Link',
    labelPlural: 'Web Links',
    icon:        '🔗',
    color:       '#64748b',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  '-createdAt',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('url',      'url',      { label: 'URL', required: true }),
      field('category', 'select',   { label: 'Category', options: ['Reference', 'Tool', 'Article', 'Video', 'Social', 'Shopping', 'Other'] }),
      field('summary',  'richtext', { label: 'Summary', isTitle: false }),
      field('tags',     'tags',     { label: 'Tags' }),
    ],
  },

  // ── 18. mealPlan ────────────────────────────────────────── //
  {
    key:         'mealPlan',
    label:       'Meal Plan',
    labelPlural: 'Meal Plans',
    icon:        '🥗',
    color:       '#84cc16',
    isBuiltIn:   true,
    graphVisible: false,
    defaultSort:  'date',
    views:        ['calendar', 'list'],
    actions:      ['create', 'edit', 'delete', 'duplicate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('date',     'date',     { label: 'Date',    required: true }),
      field('mealType', 'select',   { label: 'Meal',    options: ['Breakfast', 'Lunch', 'Dinner', 'Snack'] }),
      field('recipe',   'relation', { label: 'Recipe',  relatesTo: 'recipe' }),
      field('members',  'relation', { label: 'Members', relatesTo: 'person' }),
      field('notes',    'text',     { label: 'Notes',   isTitle: false }),
    ],
  },

  // ── 19. shoppingItem ────────────────────────────────────── //
  {
    key:         'shoppingItem',
    label:       'Shopping Item',
    labelPlural: 'Shopping Items',
    icon:        '🛒',
    color:       '#f59e0b',
    isBuiltIn:   true,
    graphVisible: false,
    defaultSort:  'title',
    views:        ['list'],
    actions:      ['create', 'edit', 'delete', 'duplicate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Item' }),
      field('quantity', 'text',     { label: 'Quantity' }),
      field('category', 'select',   { label: 'Category', options: ['Produce', 'Dairy', 'Meat', 'Bakery', 'Frozen', 'Canned', 'Household', 'Personal Care', 'Other'] }),
      field('checked',  'checkbox', { label: 'Checked',  isTitle: false }),
      field('store',    'text',     { label: 'Store' }),
      field('addedBy',  'relation', { label: 'Added By', relatesTo: 'person' }),
    ],
  },

  // ── 20. medication ──────────────────────────────────────── //
  {
    key:         'medication',
    label:       'Medication',
    labelPlural: 'Medications',
    icon:        '💊',
    color:       '#06b6d4',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'name',
    views:        ['list'],
    actions:      ['create', 'edit', 'delete', 'relate'],
    fields: [
      field('name',        'title',    { isTitle: true, label: 'Medication' }),
      field('dosage',      'text',     { label: 'Dosage' }),
      field('frequency',   'select',   { label: 'Frequency', options: ['Once Daily', 'Twice Daily', 'Three Times Daily', 'As Needed', 'Weekly', 'Monthly'] }),
      field('prescribedTo','relation', { label: 'For',        relatesTo: 'person' }),
      field('startDate',   'date',     { label: 'Start Date' }),
      field('endDate',     'date',     { label: 'End Date' }),
      field('notes',       'richtext', { label: 'Notes',      isTitle: false }),
    ],
  },

  // ── 21. appointment ─────────────────────────────────────── //
  {
    key:         'appointment',
    label:       'Appointment',
    labelPlural: 'Appointments',
    icon:        '🏥',
    color:       '#dc2626',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'date',
    views:        ['calendar', 'list'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Title' }),
      field('date',     'datetime', { label: 'Date & Time', required: true }),
      field('type',     'select',   { label: 'Type', options: ['Medical', 'Dental', 'School', 'Legal', 'Financial', 'Other'] }),
      field('location', 'text',     { label: 'Location' }),
      field('members',  'relation', { label: 'Who',    relatesTo: 'person' }),
      field('notes',    'richtext', { label: 'Notes',  isTitle: false }),
      field('reminder', 'checkbox', { label: 'Reminder Set', isTitle: false }),
    ],
  },

  // ── 22. goal ────────────────────────────────────────────── //
  {
    key:         'goal',
    label:       'Goal',
    labelPlural: 'Goals',
    icon:        '🎯',
    color:       '#7c3aed',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'deadline',
    views:        ['list', 'grid'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'convert', 'relate'],
    fields: [
      field('title',    'title',    { isTitle: true, label: 'Goal' }),
      field('why',      'richtext', { label: 'Why',    isTitle: false }),
      field('status',   'select',   { label: 'Status', options: ['Active', 'Paused', 'Achieved', 'Abandoned'] }),
      field('deadline', 'date',     { label: 'Target Date' }),
      field('progress', 'number',   { label: 'Progress %' }),
      field('members',  'relation', { label: 'Who',    relatesTo: 'person' }),
      field('project',  'relation', { label: 'Project', relatesTo: 'project' }),
      field('tags',     'tags',     { label: 'Tags' }),
    ],
  },

  // ── 23. habit ───────────────────────────────────────────── //
  {
    key:         'habit',
    label:       'Habit',
    labelPlural: 'Habits',
    icon:        '🔄',
    color:       '#0d9488',
    isBuiltIn:   true,
    graphVisible: true,
    defaultSort:  'title',
    views:        ['list'],
    actions:      ['create', 'edit', 'delete', 'duplicate', 'relate'],
    fields: [
      field('title',       'title',    { isTitle: true, label: 'Habit' }),
      field('frequency',   'select',   { label: 'Frequency', options: ['Daily', 'Weekdays', 'Weekends', 'Weekly', 'Monthly'] }),
      field('category',    'select',   { label: 'Category',  options: ['Health', 'Learning', 'Fitness', 'Mindfulness', 'Social', 'Other'] }),
      field('description', 'richtext', { label: 'Description', isTitle: false }),
      field('members',     'relation', { label: 'Who',  relatesTo: 'person' }),
      field('active',      'checkbox', { label: 'Active', isTitle: false }),
      field('tags',        'tags',     { label: 'Tags' }),
    ],
  },

  // ── 24. post ──────────────────────────────────────────── //
  {
    key:         'post',
    label:       'Post',
    labelPlural: 'Posts',
    icon:        '📢',
    color:       '#ef4444',
    isBuiltIn:   true,
    graphVisible: false,
    defaultSort:  '-createdAt',
    views:        ['wall'],
    actions:      ['create', 'edit', 'delete'],
    fields: [
      field('body',     'richtext', { isTitle: false, label: 'Content' }),
      field('postType', 'select',   { label: 'Type',  options: ['Text', 'Photo', 'Link', 'Milestone'] }),
      field('photoUrl', 'text',     { label: 'Photo URL', isTitle: false }),
      field('linkUrl',  'text',     { label: 'Link URL',  isTitle: false }),
      field('pinned',   'checkbox', { label: 'Pinned', isTitle: false }),
      field('tags',     'tags',     { label: 'Tags' }),
      field('author',   'relation', { label: 'Author', relatesTo: 'person' }),
    ],
  },

];

// ── In-memory registry ────────────────────────────────────── //

/** @type {Map<string, EntityTypeConfig>} — key → config */
let _registry = new Map();

/** @type {boolean} */
let _initialised = false;

// ── Init ──────────────────────────────────────────────────── //

/**
 * Initialise the entity type registry.
 * 1. Ensure DB is ready.
 * 2. Load custom types from settings store.
 * 3. Merge built-ins (built-ins always win on key conflicts unless archived).
 * 4. Persist defaults on first run.
 *
 * @returns {Promise<void>}
 */
export async function initGraphEngine() {
  if (_initialised) return;

  try {
    await initDB();

    // Load saved types from settings
    const saved = await getSetting(SETTINGS_KEY);

    // Rebuild registry: start with built-ins
    _registry = new Map(BUILT_IN_ENTITY_TYPES.map(t => [t.key, { ...t }]));

    if (Array.isArray(saved) && saved.length > 0) {
      for (const cfg of saved) {
        if (!cfg?.key) continue;

        if (_registry.has(cfg.key) && cfg.isBuiltIn) {
          // Merge only non-structural user overrides (e.g. archived flag)
          const existing = _registry.get(cfg.key);
          if (cfg.archived) {
            _registry.set(cfg.key, { ...existing, archived: true });
          }
        } else if (!cfg.isBuiltIn) {
          // Custom type — store as-is
          _registry.set(cfg.key, { ...cfg });
        }
      }
    } else {
      // First run — persist defaults
      await _persistRegistry();
    }

    _initialised = true;
    console.log(`[graph-engine] Initialised with ${_registry.size} entity types.`);

  } catch (err) {
    console.error('[graph-engine] initGraphEngine failed:', err);
    // Fall back to built-ins only so the app can still function
    _registry = new Map(BUILT_IN_ENTITY_TYPES.map(t => [t.key, { ...t }]));
    _initialised = true;
  }
}

// ── Persistence helpers ───────────────────────────────────── //

/** Persist the full registry to the settings store. */
async function _persistRegistry() {
  const all = Array.from(_registry.values());
  await setSetting(SETTINGS_KEY, all);
}

// ── Public API — Blueprint §10.2 ─────────────────────────── //

/**
 * Return the EntityTypeConfig for a given key.
 * Returns undefined if the type is unknown.
 *
 * @param {string} typeKey
 * @returns {EntityTypeConfig|undefined}
 */
export function getEntityTypeConfig(typeKey) {
  _assertInit();
  return _registry.get(typeKey);
}

/**
 * Return all non-archived entity type configs as an array.
 * Archived types are hidden from UI but retained in the registry for
 * backwards compatibility with existing entities.
 *
 * @param {{ includeArchived?: boolean }} [opts]
 * @returns {EntityTypeConfig[]}
 */
export function getAllEntityTypes({ includeArchived = false } = {}) {
  _assertInit();
  const all = Array.from(_registry.values());
  return includeArchived ? all : all.filter(t => !t.archived);
}

/**
 * Save (create or update) an entity type config.
 * Built-in types can be partially overridden (e.g. to archive them) but
 * their core fields cannot be replaced.
 *
 * @param {EntityTypeConfig} config
 * @returns {Promise<EntityTypeConfig>}
 */
export async function saveEntityType(config) {
  _assertInit();

  if (!config?.key) throw new Error('saveEntityType: config.key is required');

  const existing = _registry.get(config.key);

  let finalConfig;
  if (existing?.isBuiltIn) {
    // Only allow non-structural overrides on built-ins
    finalConfig = {
      ...existing,
      archived: config.archived ?? existing.archived,
      graphVisible: config.graphVisible ?? existing.graphVisible,
    };
  } else {
    finalConfig = {
      ...config,
      isBuiltIn: false,
    };
  }

  _registry.set(config.key, finalConfig);
  await _persistRegistry();

  emit(EVENTS.TYPE_CREATED, { config: finalConfig });
  console.log(`[graph-engine] [minor] saveEntityType: saved "${config.key}"`);

  return finalConfig;
}

/**
 * Archive an entity type so it no longer appears in the UI.
 * Existing entities of this type are unaffected.
 * Built-in types are archived (not deleted); custom types are removed.
 *
 * @param {string} typeKey
 * @returns {Promise<void>}
 */
export async function archiveEntityType(typeKey) {
  _assertInit();

  const existing = _registry.get(typeKey);
  if (!existing) {
    console.warn(`[graph-engine] archiveEntityType: unknown type "${typeKey}"`);
    return;
  }

  if (existing.isBuiltIn) {
    _registry.set(typeKey, { ...existing, archived: true });
  } else {
    _registry.delete(typeKey);
  }

  await _persistRegistry();
  console.log(`[graph-engine] [minor] archiveEntityType: archived "${typeKey}"`);
}

/**
 * Return all entities that link TO the given entity via any relation field.
 * i.e., "what entities reference this one?"
 *
 * @param {string} entityId
 * @returns {Promise<{ entityId: string, fromType: string, relation: string, edgeId: string }[]>}
 */
export async function getBacklinks(entityId) {
  if (!entityId) return [];

  try {
    const edges = await getEdgesTo(entityId);
    return edges.map(e => ({
      edgeId:   e.id,
      entityId: e.fromId,
      fromType: e.fromType ?? null,
      relation: e.relation,
    }));
  } catch (err) {
    console.error('[graph-engine] getBacklinks failed:', err);
    return [];
  }
}

/**
 * Return all neighbors (entities connected by any edge) of a given entity.
 * Includes both outgoing and incoming edges.
 *
 * @param {string} entityId
 * @returns {Promise<{ entityId: string, direction: 'from'|'to', relation: string, edgeId: string }[]>}
 */
export async function getNeighbors(entityId) {
  if (!entityId) return [];

  try {
    const [outgoing, incoming] = await Promise.all([
      getEdgesFrom(entityId),
      getEdgesTo(entityId),
    ]);

    const results = [
      ...outgoing.map(e => ({
        edgeId:   e.id,
        entityId: e.toId,
        direction: 'from',
        relation:  e.relation,
      })),
      ...incoming.map(e => ({
        edgeId:   e.id,
        entityId: e.fromId,
        direction: 'to',
        relation:  e.relation,
      })),
    ];

    // Deduplicate by entityId (a node can share multiple edges)
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.entityId)) return false;
      seen.add(r.entityId);
      return true;
    });

  } catch (err) {
    console.error('[graph-engine] getNeighbors failed:', err);
    return [];
  }
}

/**
 * Return a human-readable label for the edge between two entity types.
 * Falls back to a generic label if no specific label is defined.
 *
 * @param {string} fromType
 * @param {string} toType
 * @returns {string}
 */
export function getRelationLabel(fromType, toType) {
  _assertInit();

  // Look up the relation fields on the fromType config
  const fromConfig = _registry.get(fromType);
  if (!fromConfig) return 'related to';

  const relationField = fromConfig.fields.find(
    f => f.type === 'relation' && f.relatesTo === toType
  );

  if (relationField) return relationField.label;

  // Generic fallbacks by type pair
  const fallbacks = {
    'task:project':     'part of',
    'task:person':      'assigned to',
    'task:task':        'blocked by',
    'event:person':     'attended by',
    'document:person':  'belongs to',
    'dateEntity:person':'belongs to',
    'budgetEntry:person':'paid by',
    'budgetEntry:project':'for project',
    'goal:person':      'owned by',
    'goal:project':     'for project',
    'habit:person':     'practised by',
    'appointment:person':'attended by',
    'mealPlan:person':  'for',
    'mealPlan:recipe':  'uses recipe',
    'medication:person':'prescribed to',
    'shoppingItem:person':'added by',
    'trip:person':      'traveller',
  };

  return fallbacks[`${fromType}:${toType}`] ?? 'related to';
}

/**
 * Convert an existing entity to a new entity type.
 * All fields that exist on both types are carried over.
 * Fields that don't exist on the new type are dropped.
 * The title/name field is always preserved regardless of field name.
 *
 * @param {string} entityId
 * @param {string} newType
 * @returns {Promise<object>} The saved (converted) entity
 */
export async function convertEntity(entityId, newType) {
  _assertInit();

  if (!entityId) throw new Error('convertEntity: entityId is required');
  if (!newType)  throw new Error('convertEntity: newType is required');

  const targetConfig = _registry.get(newType);
  if (!targetConfig) throw new Error(`convertEntity: unknown type "${newType}"`);

  const entity = await getEntity(entityId);
  if (!entity)   throw new Error(`convertEntity: entity "${entityId}" not found`);

  const sourceConfig = _registry.get(entity.type);
  const targetFieldKeys = new Set(targetConfig.fields.map(f => f.key));

  // Find source title field key and target title field key
  const srcTitleField = sourceConfig?.fields.find(f => f.isTitle);
  const tgtTitleField = targetConfig.fields.find(f => f.isTitle);

  // Build the converted entity
  const converted = {
    id:        entity.id,
    type:      newType,
    createdAt: entity.createdAt,
    createdBy: entity.createdBy,
  };

  // Copy matching fields
  for (const fkey of targetFieldKeys) {
    if (entity[fkey] !== undefined) {
      converted[fkey] = entity[fkey];
    }
  }

  // Preserve title value across different title field names
  if (srcTitleField && tgtTitleField && srcTitleField.key !== tgtTitleField.key) {
    if (entity[srcTitleField.key] !== undefined && converted[tgtTitleField.key] === undefined) {
      converted[tgtTitleField.key] = entity[srcTitleField.key];
    }
  }

  const saved = await saveEntity(converted);
  console.log(`[graph-engine] [minor] convertEntity: "${entityId}" ${entity.type} → ${newType}`);

  return saved;
}

// ── Internal helpers ──────────────────────────────────────── //

/** Throw if the engine has not been initialised. */
function _assertInit() {
  if (!_initialised) {
    throw new Error('[graph-engine] Not initialised. Call initGraphEngine() first.');
  }
}
