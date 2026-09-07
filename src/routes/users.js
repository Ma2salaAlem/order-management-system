const express = require('express');
const router = express.Router();

const authenticate = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const { listUsers, createUser, updateUser, deleteUser } = require('../controllers/userController');

router.use(authenticate);
router.use(roleGuard(['MANAGER']));

router.get('/', listUsers);
router.post('/', createUser);
router.patch('/:id', updateUser);
router.delete('/:id', deleteUser);

module.exports = router;
