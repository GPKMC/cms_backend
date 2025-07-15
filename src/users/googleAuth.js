import express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import jwt from 'jsonwebtoken';
import User from './user-model.js';

const googleAuthRouter = express.Router();

// Configure Passport Google OAuth strategy
passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: '/api/auth/google/callback',
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                const email = profile.emails[0].value.toLowerCase();

                // Look for user in DB by email
                const user = await User.findOne({ email });

                if (!user) {
                    // Reject login if user not found in your DB
                    return done(null, false, { message: 'Email not registered. Contact admin.' });
                }

                // User found, pass user to next middleware
                return done(null, user);
            } catch (err) {
                return done(err, null);
            }
        }
    )
);

// Passport requires these, but won't be used since sessions are off
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, id));

// Route to initiate Google OAuth login
googleAuthRouter.get(
    '/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback route
googleAuthRouter.get(
    '/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login?error=google_auth_failed' }),
    (req, res) => {
        // req.user contains user from DB

        // Create JWT token
        const token = jwt.sign(
            {
                id: req.user._id,
                email: req.user.email,
                role: req.user.role,
            },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Redirect user to frontend with token as query param
        res.redirect(`${process.env.CLIENT_URL}/google-success?token=${token}`);
    }
);

export default googleAuthRouter;
