import mongoose from 'mongoose';

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URL);
        console.log('MongoDB connectd successfully');

    }
    catch (error) {
        console.error('failed to connect mongoDB.', error.message);
        process.exit(1);
    }
}
export default connectDB;